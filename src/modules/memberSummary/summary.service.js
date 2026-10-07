const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { MAX_PRICE_PAISE, MAX_DURATION_DAYS } = require('../membershipPlans/plan.validation');
const { summaryInput } = require('./summary.validation');
function fail(code = 'INVALID_SUMMARY_STATE') { const error = new Error('Member summary unavailable.'); error.code = code; throw error; }
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function pick(value, fields) { return value ? Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]])) : undefined; }
const addressFields = ['line1', 'line2', 'city', 'state', 'postalCode', 'countryCode'];
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('INVALID_FINANCIAL_STATE'); return value;
}
function exactTotal(value) {
  let amount;
  try { amount = BigInt(value?.toString() ?? '0'); } catch { fail('INVALID_FINANCIAL_STATE'); }
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FINANCIAL_STATE');
  return Number(amount);
}
function subscriptionDto(record, today) {
  if (!['active', 'expired', 'cancelled'].includes(record.status) || !(record.startDate instanceof Date)
    || !(record.endDate instanceof Date) || !calendarDate.safeParse(record.startDate.toISOString().slice(0, 10)).success
    || !calendarDate.safeParse(record.endDate.toISOString().slice(0, 10)).success
    || !record.startDate.toISOString().endsWith('T00:00:00.000Z') || !record.endDate.toISOString().endsWith('T00:00:00.000Z')
    || typeof record.planNameSnapshot !== 'string' || !record.planNameSnapshot.length || record.planNameSnapshot.length > 120
    || !Number.isSafeInteger(record.durationDaysSnapshot) || record.durationDaysSnapshot < 1 || record.durationDaysSnapshot > MAX_DURATION_DAYS) fail();
  const expected = new Date(record.startDate); expected.setUTCDate(expected.getUTCDate() + record.durationDaysSnapshot);
  if (expected.getTime() !== record.endDate.getTime()) fail();
  return { id: String(record._id), membershipPlanId: String(record.membershipPlanId), planNameSnapshot: record.planNameSnapshot,
    durationDaysSnapshot: record.durationDaysSnapshot, pricePaiseSnapshot: integer(record.pricePaiseSnapshot, MAX_PRICE_PAISE),
    startDate: record.startDate.toISOString().slice(0, 10), endDate: record.endDate.toISOString().slice(0, 10),
    status: record.status === 'cancelled' ? 'cancelled' : record.endDate <= today ? 'expired' : 'active',
    isCurrentlyActive: record.status !== 'cancelled' && record.startDate <= today && record.endDate > today,
    previousSubscriptionId: record.previousSubscriptionId ? String(record.previousSubscriptionId) : null };
}
function paymentDto(record) { return record ? { id: String(record._id), subscriptionId: String(record.subscriptionId),
  amountPaise: integer(record.amountPaise, MAX_PRICE_PAISE), paymentMethod: record.paymentMethod,
  paidAt: record.paidAt, transactionReference: record.transactionReference } : null; }
function attendanceDto(record) {
  if (!record) return null;
  if (!['open', 'completed', 'cancelled'].includes(record.status) || !(record.checkInAt instanceof Date)
    || (record.status === 'completed' && !(record.checkOutAt instanceof Date)) || (record.status === 'open' && record.checkOutAt)
    || (record.checkOutAt && record.checkOutAt < record.checkInAt)) fail();
  return { id: String(record._id), branchId: String(record.branchId), subscriptionId: String(record.subscriptionId),
    checkInAt: record.checkInAt, checkOutAt: record.checkOutAt ?? null, status: record.status };
}
function createMemberSummaryService({ MemberProfile, Branch, TrainerProfile, TrainerMemberAssignment,
  MemberSubscription, MembershipPlan, Payment, Attendance, authorizationService }) {
  async function memberFor(auth, authorization, memberId) {
    const id = parse(objectId, memberId);
    authorizationService.requireRoles(auth, authorization, ['admin', 'trainer'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin', 'trainer'], authorization.gymId);
    if (current.role === 'trainer') {
      const trainers = await TrainerProfile.find({ userId: auth.user._id, gymId: current.gymId, status: 'active' }).select('_id').limit(2).lean();
      if (trainers.length !== 1) fail('FORBIDDEN');
      if (!await TrainerMemberAssignment.exists({ gymId: current.gymId, trainerId: trainers[0]._id, memberId: id, status: 'active' })) fail('MEMBER_NOT_FOUND');
    }
    const member = await MemberProfile.findOne({ _id: id, gymId: current.gymId })
      .select('memberCode firstName lastName phone status branchId dateOfBirth gender address emergencyContact createdAt updatedAt').lean();
    if (!member) fail('MEMBER_NOT_FOUND'); return { member, gymId: new Types.ObjectId(current.gymId) };
  }
  function subscriptionLinks(gymId) {
    return [
      { $lookup: { from: MembershipPlan.collection.name, localField: 'membershipPlanId', foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'plan' } },
      { $lookup: { from: MemberSubscription.collection.name, let: { previousId: '$previousSubscriptionId', memberId: '$memberId', startDate: '$startDate' },
        pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$previousId'] }, { $eq: ['$memberId', '$$memberId'] },
          { $lte: ['$endDate', '$$startDate'] }] } } }, { $project: { _id: 1 } }], as: 'previous' } },
    ];
  }
  async function subscriptions(filter, today, page, limit) {
    const [result] = await MemberSubscription.aggregate([{ $match: filter }, ...subscriptionLinks(filter.gymId),
      { $facet: {
        invalid: [{ $match: { $or: [{ 'plan.0': { $exists: false } }, { status: { $nin: ['active', 'expired', 'cancelled'] } },
          { previousSubscriptionId: { $ne: null }, 'previous.0': { $exists: false } }] } }, { $count: 'total' }],
        current: [{ $match: { status: { $ne: 'cancelled' }, startDate: { $lte: today }, endDate: { $gt: today } } }, { $limit: 2 }],
        items: [{ $sort: { startDate: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        count: [{ $count: 'total' }],
      } }]);
    if (result.invalid.length || result.current.length > 1) fail();
    const current = result.current[0] ? subscriptionDto(result.current[0], today) : null;
    if (result.current[0] && result.current[0].status !== 'active') fail();
    return { current, history: { items: result.items.map((record) => subscriptionDto(record, today)),
      total: result.count[0]?.total ?? 0, page, limit } };
  }
  function subscriptionReference(gymId) {
    return { $lookup: { from: MemberSubscription.collection.name, let: { subscriptionId: '$subscriptionId', memberId: '$memberId' },
      pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$subscriptionId'] }, { $eq: ['$memberId', '$$memberId'] }] } } },
        { $project: { _id: 1 } }], as: 'subscription' } };
  }
  async function payments(filter, current) {
    const total = [{ $group: { _id: null, amount: { $sum: { $convert: { input: '$amountPaise', to: 'decimal', onError: 0, onNull: 0 } } }, count: { $sum: 1 } } }];
    const [result] = await Payment.aggregate([{ $match: { ...filter, status: 'succeeded' } }, subscriptionReference(filter.gymId),
      { $set: { validAmount: { $cond: [{ $isNumber: '$amountPaise' }, { $and: [{ $gt: ['$amountPaise', 0] },
        { $lte: ['$amountPaise', MAX_PRICE_PAISE] }, { $eq: ['$amountPaise', { $trunc: '$amountPaise' }] }] }, false] } } },
      { $facet: {
        invalid: [{ $match: { $or: [{ validAmount: false }, { 'subscription.0': { $exists: false } }] } }, { $count: 'total' }],
        total, latest: [{ $sort: { paidAt: -1, _id: -1 } }, { $limit: 1 }],
        current: [{ $match: { subscriptionId: current ? new Types.ObjectId(current.id) : null } }, ...total],
      } }]);
    if (result.invalid.length) fail('INVALID_FINANCIAL_STATE');
    const collected = result.total[0]; const paid = result.current[0];
    const paidAmountPaise = exactTotal(paid?.amount);
    if (current && paidAmountPaise > current.pricePaiseSnapshot) fail('INVALID_FINANCIAL_STATE');
    return { summary: { totalSuccessfulAmountPaise: exactTotal(collected?.amount), successfulPaymentCount: integer(collected?.count ?? 0),
      latestSuccessfulPayment: paymentDto(result.latest[0]) }, current: current ? { pricePaise: current.pricePaiseSnapshot,
      paidAmountPaise, remainingAmountPaise: current.pricePaiseSnapshot - paidAmountPaise, paymentCount: integer(paid?.count ?? 0) } : null };
  }
  async function attendance(filter) {
    const [result] = await Attendance.aggregate([{ $match: filter }, subscriptionReference(filter.gymId),
      { $lookup: { from: Branch.collection.name, localField: 'branchId', foreignField: '_id',
        pipeline: [{ $match: { gymId: filter.gymId } }, { $project: { _id: 1 } }], as: 'branch' } },
      { $facet: {
        invalid: [{ $match: { $or: [{ 'subscription.0': { $exists: false } }, { 'branch.0': { $exists: false } },
          { status: { $nin: ['open', 'completed', 'cancelled'] } }] } }, { $count: 'total' }],
        completed: [{ $match: { status: 'completed' } }, { $count: 'total' }],
        latest: [{ $sort: { checkInAt: -1, _id: -1 } }, { $limit: 1 }],
        open: [{ $match: { status: 'open' } }, { $limit: 2 }],
      } }]);
    if (result.invalid.length || result.open.length > 1) fail();
    return { totalCompletedVisits: result.completed[0]?.total ?? 0, latestAttendance: attendanceDto(result.latest[0]),
      currentlyCheckedIn: result.open.length === 1, currentAttendance: attendanceDto(result.open[0]) };
  }
  async function trainers(filter) {
    const records = await TrainerMemberAssignment.aggregate([{ $match: { ...filter, status: 'active' } },
      { $lookup: { from: TrainerProfile.collection.name, localField: 'trainerId', foreignField: '_id',
        pipeline: [{ $match: { gymId: filter.gymId, status: 'active' } },
          { $project: { trainerCode: 1, firstName: 1, lastName: 1, phone: 1, specializations: 1 } }], as: 'trainer' } },
      { $unwind: '$trainer' }, { $sort: { assignedAt: -1, _id: -1 } }, { $limit: 101 }]);
    if (records.length > 100) fail();
    return records.map(({ trainer, assignedAt }) => ({ trainerId: String(trainer._id),
      ...pick(trainer, ['trainerCode', 'firstName', 'lastName', 'phone', 'specializations']), assignedAt }));
  }
  return {
    async authorizeRead(auth, authorization, memberId) { await memberFor(auth, authorization, memberId); },
    async get(auth, authorization, memberId, query) {
      const { page, limit } = parse(summaryInput, query); const { member, gymId } = await memberFor(auth, authorization, memberId);
      const date = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const filter = { gymId, memberId: member._id };
      // Fixed query count; no per-subscription or per-trainer database calls.
      const [subs, visits, currentTrainers, branch] = await Promise.all([
        subscriptions(filter, date, page, limit), attendance(filter), trainers(filter),
        member.branchId ? Branch.findOne({ _id: member.branchId, gymId }).select('name status address contact').lean() : null,
      ]);
      const money = await payments(filter, subs.current);
      return { member: { id: String(member._id), ...pick(member, ['memberCode', 'firstName', 'lastName', 'phone', 'status', 'gender', 'createdAt', 'updatedAt']),
        branchId: branch ? String(branch._id) : null, dateOfBirth: member.dateOfBirth?.toISOString().slice(0, 10),
        address: pick(member.address, addressFields), emergencyContact: pick(member.emergencyContact, ['name', 'phone', 'relationship']) },
      currentBranch: branch ? { id: String(branch._id), name: branch.name, status: branch.status,
        address: pick(branch.address, addressFields), contact: pick(branch.contact, ['email', 'phone']) } : null,
      currentTrainers, currentSubscription: subs.current, subscriptionHistory: subs.history,
      paymentSummary: money.summary, currentSubscriptionPaymentSummary: money.current, attendanceSummary: visits };
    },
  };
}
module.exports = { createMemberSummaryService };
