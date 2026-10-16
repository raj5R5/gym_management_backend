const { photoFields } = require('../memberPhotos/photo.dto');
const { exactTotal } = require('../payments/payment.service');
const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { MAX_PRICE_PAISE, MAX_DURATION_DAYS } = require('../membershipPlans/plan.validation');
const { summaryInput } = require('./summary.validation');
const { attendanceDto: visitDto } = require('../attendance/attendance.service');
function fail(code = 'INVALID_SUMMARY_STATE') { const error = new Error('Member summary unavailable.'); error.code = code; throw error; }
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function pick(value, fields) { return value ? Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]])) : undefined; }
const addressFields = ['line1', 'line2', 'city', 'state', 'postalCode', 'countryCode'];
function profileDto(member, branch) {
  return { member: { ...photoFields(member), id: String(member._id), ...pick(member, ['memberCode', 'firstName', 'lastName', 'phone', 'status', 'gender', 'createdAt', 'updatedAt']),
    branchId: branch ? String(branch._id) : null, dateOfBirth: member.dateOfBirth?.toISOString().slice(0, 10),
    address: pick(member.address, addressFields), emergencyContact: pick(member.emergencyContact, ['name', 'phone', 'relationship']) },
  currentBranch: branch ? { id: String(branch._id), name: branch.name, status: branch.status,
    address: pick(branch.address, addressFields), contact: pick(branch.contact, ['email', 'phone']) } : null };
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('INVALID_FINANCIAL_STATE'); return value;
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
  MemberSubscription, MembershipPlan, Payment, Attendance, authorizationService, resolveSelfMember }) {
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
      .select('gymId photoUrl photoPublicId photoRevision memberCode firstName lastName phone status branchId dateOfBirth gender address emergencyContact createdAt updatedAt').lean();
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
  async function subscriptions(filter, today, page, limit, historyFilter = {}) {
    const [result] = await MemberSubscription.aggregate([{ $match: filter }, ...subscriptionLinks(filter.gymId),
      { $facet: {
        invalid: [{ $match: { $or: [{ 'plan.0': { $exists: false } }, { status: { $nin: ['active', 'expired', 'cancelled'] } },
          { previousSubscriptionId: { $ne: null }, 'previous.0': { $exists: false } }] } }, { $count: 'total' }],
        current: [{ $match: { status: { $ne: 'cancelled' }, startDate: { $lte: today }, endDate: { $gt: today } } }, { $limit: 2 }],
        items: [{ $match: historyFilter }, { $sort: { startDate: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
        count: [{ $match: historyFilter }, { $count: 'total' }],
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
  async function payments(filter, current, pagination) {
    const total = [{ $group: { _id: null, amount: { $sum: { $convert: { input: '$amountPaise', to: 'decimal', onError: 0, onNull: 0 } } }, count: { $sum: 1 } } }];
    const [result] = await Payment.aggregate([{ $match: { ...filter, status: 'succeeded' } }, subscriptionReference(filter.gymId),
      { $set: { validAmount: { $cond: [{ $isNumber: '$amountPaise' }, { $and: [{ $gt: ['$amountPaise', 0] },
        { $lte: ['$amountPaise', MAX_PRICE_PAISE] }, { $eq: ['$amountPaise', { $trunc: '$amountPaise' }] }] }, false] } } },
      { $facet: {
        invalid: [{ $match: { $or: [{ validAmount: false }, { 'subscription.0': { $exists: false } }] } }, { $count: 'total' }],
        total, latest: [{ $sort: { paidAt: -1, _id: -1 } }, { $limit: 1 }],
        current: [{ $match: { subscriptionId: current ? new Types.ObjectId(current.id) : null } }, ...total],
        ...(pagination ? { items: [{ $sort: { paidAt: -1, _id: -1 } }, { $skip: (pagination.page - 1) * pagination.limit }, { $limit: pagination.limit }] } : {}),
      } }]);
    if (result.invalid.length) fail('INVALID_FINANCIAL_STATE');
    const collected = result.total[0]; const paid = result.current[0];
    const paidAmountPaise = exactTotal(paid?.amount);
    if (current && paidAmountPaise > current.pricePaiseSnapshot) fail('INVALID_FINANCIAL_STATE');
    return { ...(pagination ? { items: result.items.map(paymentDto) } : {}), summary: { totalSuccessfulAmountPaise: exactTotal(collected?.amount), successfulPaymentCount: integer(collected?.count ?? 0),
      latestSuccessfulPayment: paymentDto(result.latest[0]) }, current: current ? { pricePaise: current.pricePaiseSnapshot,
      paidAmountPaise, remainingAmountPaise: current.pricePaiseSnapshot - paidAmountPaise, paymentCount: integer(paid?.count ?? 0) } : null };
  }
  async function attendance(filter, pagination) {
    const [result] = await Attendance.aggregate([{ $match: filter }, subscriptionReference(filter.gymId),
      { $lookup: { from: Branch.collection.name, localField: 'branchId', foreignField: '_id',
        pipeline: [{ $match: { gymId: filter.gymId } }, { $project: { _id: 1 } }], as: 'branch' } },
      { $facet: {
        invalid: [{ $match: { $or: [{ 'subscription.0': { $exists: false } }, { 'branch.0': { $exists: false } },
          { status: { $nin: ['open', 'completed', 'cancelled'] } }] } }, { $count: 'total' }],
        completed: [{ $match: { status: 'completed' } }, { $count: 'total' }],
        latest: [{ $sort: { checkInAt: -1, _id: -1 } }, { $limit: 1 }],
        open: [{ $match: { status: 'open' } }, { $limit: 2 }],
        ...(pagination ? { items: [{ $sort: { checkInAt: -1, _id: -1 } }, { $skip: (pagination.page - 1) * pagination.limit }, { $limit: pagination.limit }], count: [{ $count: 'total' }] } : {}),
      } }]);
    if (result.invalid.length || result.open.length > 1) fail();
    return { ...(pagination ? { items: result.items.map((record) => pick(visitDto(record), ['id', 'branchId', 'checkInAt', 'checkOutAt', 'status', 'durationMs'])),
      total: result.count[0]?.total ?? 0 } : {}), totalCompletedVisits: result.completed[0]?.total ?? 0, latestAttendance: attendanceDto(result.latest[0]),
      currentlyCheckedIn: result.open.length === 1, currentAttendance: attendanceDto(result.open[0]) };
  }
  async function trainers(filter, pagination) {
    const records = await TrainerMemberAssignment.aggregate([{ $match: { ...filter, status: 'active' } },
      { $lookup: { from: TrainerProfile.collection.name, localField: 'trainerId', foreignField: '_id',
        pipeline: [{ $match: { gymId: filter.gymId, status: 'active' } },
          { $project: { trainerCode: 1, firstName: 1, lastName: 1, phone: 1, specializations: 1, ...(pagination ? { branchId: 1 } : {}) } }], as: 'trainer' } },
      { $unwind: '$trainer' }, ...(pagination ? [{ $facet: {
        records: [{ $sort: { assignedAt: -1, _id: -1 } }, { $skip: (pagination.page - 1) * pagination.limit }, { $limit: pagination.limit },
          { $lookup: { from: Branch.collection.name, localField: 'trainer.branchId', foreignField: '_id',
            pipeline: [{ $match: { gymId: filter.gymId } }, { $project: { _id: 1 } }], as: 'branch' } }], count: [{ $count: 'total' }],
      } }] : [{ $sort: { assignedAt: -1, _id: -1 } }, { $limit: 101 }])]);
    if (pagination) return { data: records[0].records.map(({ _id, trainer, assignedAt, branch }) => ({ trainerId: String(trainer._id),
      ...pick(trainer, ['trainerCode', 'firstName', 'lastName', 'phone', 'specializations']),
      ...(branch.length ? { branchId: String(branch[0]._id) } : {}), assignmentId: String(_id), assignedAt })),
    pagination: { ...pagination, total: records[0].count[0]?.total ?? 0 } };
    if (records.length > 100) fail();
    return records.map(({ trainer, assignedAt }) => ({ trainerId: String(trainer._id),
      ...pick(trainer, ['trainerCode', 'firstName', 'lastName', 'phone', 'specializations']), assignedAt }));
  }
  return {
    async selfRead(auth, authorization, kind, query) {
      if (!['profile', 'membership', 'payments', 'attendance', 'trainers'].includes(kind)) fail('VALIDATION_ERROR');
      const pagination = kind === 'profile' ? null : parse(summaryInput, query);
      if (typeof resolveSelfMember !== 'function') fail('FORBIDDEN');
      const member = await resolveSelfMember(auth, authorization);
      const gymId = new Types.ObjectId(member.gymId); const filter = { gymId, memberId: member._id };
      if (kind === 'profile') {
        const branch = member.branchId ? await Branch.findOne({ _id: member.branchId, gymId }).select('name status address contact').lean() : null;
        return { data: profileDto(member, branch) };
      }
      if (kind === 'membership') {
        const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
        const result = await subscriptions(filter, today, pagination.page, pagination.limit);
        return { data: { currentMembership: result.current, subscriptions: result.history.items }, pagination: { ...pagination, total: result.history.total } };
      }
      if (kind === 'payments') {
        const result = await payments(filter, null, pagination);
        return { data: { payments: result.items, totalSuccessfulPaidPaise: result.summary.totalSuccessfulAmountPaise },
          pagination: { ...pagination, total: result.summary.successfulPaymentCount } };
      }
      if (kind === 'attendance') {
        const result = await attendance(filter, pagination);
        return { data: result.items, pagination: { ...pagination, total: result.total } };
      }
      return trainers(filter, pagination);
    },
    async membershipHistory(auth, authorization, memberId, { page, limit, status, from, to }) {
      if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100
        || (status && !['active', 'expired', 'cancelled'].includes(status))
        || (from && !calendarDate.safeParse(from).success) || (to && !calendarDate.safeParse(to).success)
        || (from && to && from > to)) fail('VALIDATION_ERROR');
      const { member, gymId } = await memberFor(auth, authorization, memberId);
      const date = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const filter = {};
      if (status === 'cancelled') filter.status = 'cancelled';
      else if (status) { filter.status = { $ne: 'cancelled' }; filter.endDate = status === 'expired' ? { $lte: date } : { $gt: date }; }
      if (from || to) filter.startDate = { ...(from ? { $gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { $lte: new Date(`${to}T00:00:00Z`) } : {}) };
      const subs = await subscriptions({ gymId, memberId: member._id }, date, page, limit, filter);
      return { member: { id: String(member._id), ...pick(member, ['memberCode', 'firstName', 'lastName']) },
        currentMembership: subs.current, subscriptions: subs.history.items,
        pagination: { page, limit, total: subs.history.total } };
    },
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
      return { ...profileDto(member, branch),
      currentTrainers, currentSubscription: subs.current, subscriptionHistory: subs.history,
      paymentSummary: money.summary, currentSubscriptionPaymentSummary: money.current, attendanceSummary: visits };
    },
  };
}
module.exports = { createMemberSummaryService };
