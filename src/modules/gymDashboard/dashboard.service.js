const { Types } = require('mongoose');
const { dashboardQuery } = require('./dashboard.validation');
const { dashboardPeriod } = require('./dashboard.period');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
function fail(code = 'INVALID_DASHBOARD_STATE') { const error = new Error('Dashboard unavailable.'); error.code = code; throw error; }
function count(value = 0) { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; }
function exactMoney(value) {
  let amount; try { amount = BigInt(value?.toString() ?? '0'); } catch { fail('INVALID_FINANCIAL_STATE'); }
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FINANCIAL_STATE'); return Number(amount);
}
function createDashboardService({ Gym, MemberProfile, TrainerProfile, MembershipPlan, MemberSubscription, Payment, Attendance, Branch,
  authorizationService, clock = () => new Date() }) {
  async function profiles(model, gymId, branchId) {
    const records = await model.aggregate([{ $match: { gymId, ...(branchId ? { branchId } : {}) } },
      { $group: { _id: '$status', count: { $sum: 1 } } }]);
    const result = { total: 0, active: 0, inactive: 0, suspended: 0 };
    for (const record of records) { if (!['active', 'inactive', 'suspended'].includes(record._id)) fail();
      result[record._id] = count(record.count); result.total = count(result.total + record.count); }
    return result;
  }
  function memberJoin(gymId, branchId) {
    return [{ $lookup: { from: MemberProfile.collection.name, localField: 'memberId', foreignField: '_id',
      pipeline: [{ $match: { gymId, ...(branchId ? { branchId } : {}) } }, { $project: { _id: 1 } }], as: 'member' } }, { $unwind: '$member' }];
  }
  function subscriptionJoin(gymId) {
    return [{ $lookup: { from: MemberSubscription.collection.name, let: { id: '$subscriptionId', memberId: '$memberId' },
      pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$id'] }, { $eq: ['$memberId', '$$memberId'] }] } } },
        { $project: { _id: 1 } }], as: 'subscription' } }, { $unwind: '$subscription' }];
  }
  async function subscriptions(gymId, branchId, today) {
    const soon = new Date(today); soon.setUTCDate(soon.getUTCDate() + 7);
    const [result] = await MemberSubscription.aggregate([{ $match: { gymId, status: { $ne: 'cancelled' } } }, ...memberJoin(gymId, branchId),
      { $lookup: { from: MembershipPlan.collection.name, localField: 'membershipPlanId', foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'plan' } }, { $unwind: '$plan' },
      { $facet: {
        invalid: [{ $match: { status: { $nin: ['active', 'expired'] } } }, { $count: 'total' }],
        active: [{ $match: { startDate: { $lte: today }, endDate: { $gt: today } } },
          { $group: { _id: '$memberId', periods: { $sum: 1 }, expiring: { $sum: { $cond: [{ $lte: ['$endDate', soon] }, 1, 0] } } } },
          { $group: { _id: null, total: { $sum: '$periods' }, soon: { $sum: '$expiring' }, ambiguous: { $sum: { $cond: [{ $gt: ['$periods', 1] }, 1, 0] } } } }],
        expired: [{ $match: { endDate: { $lte: today } } }, { $count: 'total' }],
      } }]);
    const active = result.active[0]; if (result.invalid.length || active?.ambiguous) fail();
    return { currentlyActive: count(active?.total), expiringSoon: count(active?.soon), expired: count(result.expired[0]?.total) };
  }
  async function payments(gymId, branchId, start, end) {
    const [result] = await Payment.aggregate([{ $match: { gymId, status: 'succeeded', paidAt: { $gte: start, $lt: end } } },
      ...memberJoin(gymId, branchId), ...subscriptionJoin(gymId),
      { $set: { validAmount: { $cond: [{ $isNumber: '$amountPaise' }, { $and: [{ $gt: ['$amountPaise', 0] },
        { $lte: ['$amountPaise', MAX_PRICE_PAISE] }, { $eq: ['$amountPaise', { $trunc: '$amountPaise' }] }] }, false] } } },
      { $group: { _id: null, amount: { $sum: { $convert: { input: '$amountPaise', to: 'decimal', onError: 0, onNull: 0 } } },
        total: { $sum: 1 }, invalid: { $sum: { $cond: ['$validAmount', 0, 1] } } } }]);
    if (result?.invalid) fail('INVALID_FINANCIAL_STATE');
    return { periodSuccessfulAmountPaise: exactMoney(result?.amount), periodSuccessfulCount: count(result?.total) };
  }
  async function outstanding(gymId, branchId) {
    // A current receivable, independent of revenue's paidAt/date-period filter.
    // One row per subscription; aggregate payments inside the lookup so multiple
    // installments cannot multiply the price snapshot or another member's debt.
    const validPaise = (field, minimum) => ({ $cond: [{ $isNumber: field }, { $and: [
      { $gte: [field, minimum] }, { $lte: [field, MAX_PRICE_PAISE] },
      { $eq: [field, { $trunc: field }] },
    ] }, false] });
    const decimal = (field) => ({ $convert: { input: field, to: 'decimal', onError: 0, onNull: 0 } });
    const [result] = await MemberSubscription.aggregate([
      { $match: { gymId, status: { $ne: 'cancelled' } } }, ...memberJoin(gymId, branchId),
      { $lookup: { from: MembershipPlan.collection.name, localField: 'membershipPlanId', foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'plan' } }, { $unwind: '$plan' },
      { $lookup: { from: Payment.collection.name, let: { id: '$_id', memberId: '$memberId' },
        pipeline: [{ $match: { gymId, status: 'succeeded', $expr: { $and: [
          { $eq: ['$subscriptionId', '$$id'] }, { $eq: ['$memberId', '$$memberId'] },
        ] } } },
        { $group: { _id: null, amount: { $sum: decimal('$amountPaise') },
          invalid: { $sum: { $cond: [validPaise('$amountPaise', 1), 0, 1] } } } }], as: 'paid' } },
      { $set: { balance: { $subtract: [decimal('$pricePaiseSnapshot'), { $ifNull: [{ $arrayElemAt: ['$paid.amount', 0] }, 0] }] },
        validPrice: validPaise('$pricePaiseSnapshot', 0),
        invalidPayments: { $ifNull: [{ $arrayElemAt: ['$paid.invalid', 0] }, 0] } } },
      { $group: { _id: null, amount: { $sum: '$balance' }, invalid: { $sum: { $cond: [{ $and: [
        '$validPrice', { $in: ['$status', ['active', 'expired']] },
        { $eq: ['$invalidPayments', 0] }, { $gte: ['$balance', 0] },
      ] }, 0, 1] } } } },
    ]);
    if (result?.invalid) fail('INVALID_FINANCIAL_STATE');
    return exactMoney(result?.amount);
  }
  async function attendance(gymId, branchId, start, end) {
    const [result] = await Attendance.aggregate([{ $match: { gymId, ...(branchId ? { branchId } : {}),
      $or: [{ status: 'open' }, { status: 'completed', checkInAt: { $gte: start, $lt: end } }] } },
      ...memberJoin(gymId), ...subscriptionJoin(gymId),
      { $lookup: { from: Branch.collection.name, localField: 'branchId', foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'branch' } }, { $unwind: '$branch' },
      { $facet: {
        visits: [{ $match: { status: 'completed' } }, { $count: 'total' }],
        unique: [{ $match: { status: 'completed' } }, { $group: { _id: '$memberId' } }, { $count: 'total' }],
        open: [{ $match: { status: 'open' } }, { $group: { _id: '$memberId', visits: { $sum: 1 } } },
          { $group: { _id: null, total: { $sum: 1 }, ambiguous: { $sum: { $cond: [{ $gt: ['$visits', 1] }, 1, 0] } } } }],
      } }]);
    if (result.open[0]?.ambiguous) fail();
    return { periodVisits: count(result.visits[0]?.total), periodUniqueMembers: count(result.unique[0]?.total), currentlyCheckedIn: count(result.open[0]?.total) };
  }
  return { async get(auth, authorization, query) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    const parsed = dashboardQuery.safeParse(query); if (!parsed.success) fail('VALIDATION_ERROR'); const input = parsed.data;
    const gymId = new Types.ObjectId(current.gymId); const branchId = input.branchId ? new Types.ObjectId(input.branchId) : undefined;
    if (branchId) await authorizationService.requireBranchAccess(auth, current, current.gymId, input.branchId);
    const gym = await Gym.findOne({ _id: gymId, status: 'active' }).select('settings.timezone').lean(); if (!gym) fail('FORBIDDEN');
    const timezone = gym.settings?.timezone ?? 'UTC'; if (typeof timezone !== 'string' || !timezone) fail();
    const period = await dashboardPeriod(Gym, gymId, timezone, input, clock());
    const [members, trainers, subs, paid, visits, dues] = await Promise.all([profiles(MemberProfile, gymId, branchId),
      profiles(TrainerProfile, gymId, branchId), subscriptions(gymId, branchId, period.today),
      payments(gymId, branchId, period.start, period.end), attendance(gymId, branchId, period.start, period.end), outstanding(gymId, branchId)]);
    return { period: period.dto, members, trainers, subscriptions: subs, payments: { ...paid, outstandingAmountPaise: dues }, attendance: visits };
  } };
}
module.exports = { createDashboardService };
