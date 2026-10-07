const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { checkIn, checkOut, attendanceListInput } = require('./attendance.validation');
function fail(code) { const error = new Error('Attendance operation failed.'); error.code = code; throw error; }
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function dto(record) {
  if (!['open', 'completed', 'cancelled'].includes(record.status) || !(record.checkInAt instanceof Date)
    || (record.status === 'completed' && !record.checkOutAt) || (record.status === 'open' && record.checkOutAt)
    || (record.checkOutAt && record.checkOutAt < record.checkInAt)) fail('INVALID_ATTENDANCE_STATE');
  return { id: String(record._id), gymId: String(record.gymId), memberId: String(record.memberId),
    branchId: String(record.branchId), subscriptionId: String(record.subscriptionId), status: record.status,
    checkInAt: record.checkInAt, checkOutAt: record.checkOutAt ?? null,
    durationMs: record.checkOutAt ? record.checkOutAt.getTime() - record.checkInAt.getTime() : null,
    recordedByUserId: String(record.recordedByUserId), createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function createAttendanceService({ Attendance, MemberProfile, Branch, MemberSubscription, MembershipPlan,
  TrainerProfile, TrainerMemberAssignment, authorizationService }) {
  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin', 'trainer'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin', 'trainer'], authorization.gymId);
    if (current.role === 'admin') return { gymId: current.gymId };
    const trainers = await TrainerProfile.find({ userId: auth.user._id, gymId: current.gymId, status: 'active' }).select('_id').limit(2).lean();
    if (trainers.length !== 1) fail('FORBIDDEN');
    return { gymId: current.gymId, trainerId: trainers[0]._id };
  }
  async function assigned(selected, memberId) {
    if (selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId,
      trainerId: selected.trainerId, memberId, status: 'active' })) fail('MEMBER_NOT_FOUND');
  }
  function relationshipStages(selected) {
    const gymId = new Types.ObjectId(selected.gymId);
    const stages = [[MemberProfile, 'memberId', 'member'], [Branch, 'branchId', 'branch']].flatMap(([model, field, alias]) => [
      { $lookup: { from: model.collection.name, localField: field, foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: alias } }, { $unwind: `$${alias}` },
    ]);
    stages.push({ $lookup: { from: MemberSubscription.collection.name, let: { subscriptionId: '$subscriptionId', memberId: '$memberId' },
      pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$subscriptionId'] }, { $eq: ['$memberId', '$$memberId'] }] } } },
        { $project: { _id: 1 } }], as: 'subscription' } }, { $unwind: '$subscription' });
    if (selected.trainerId) stages.push({ $lookup: { from: TrainerMemberAssignment.collection.name, localField: 'memberId', foreignField: 'memberId',
      pipeline: [{ $match: { gymId, trainerId: selected.trainerId, status: 'active' } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'assignment' } },
    { $match: { 'assignment.0': { $exists: true } } });
    return stages;
  }
  async function existing(selected, attendanceId) {
    const records = await Attendance.aggregate([{ $match: { _id: new Types.ObjectId(parse(objectId, attendanceId)),
      gymId: new Types.ObjectId(selected.gymId) } }, ...relationshipStages(selected)]);
    if (!records.length) fail('ATTENDANCE_NOT_FOUND'); return records[0];
  }
  return {
    async authorizeRead(auth, authorization, attendanceId) {
      const selected = await scope(auth, authorization); if (attendanceId !== undefined) await existing(selected, attendanceId);
    },
    async checkIn(auth, authorization, input) {
      const selected = await scope(auth, authorization); const data = parse(checkIn, input); const { gymId } = selected;
      await assigned(selected, data.memberId);
      const member = await MemberProfile.findOne({ _id: data.memberId, gymId }).select('_id branchId status').lean();
      if (!member) fail('MEMBER_NOT_FOUND'); if (member.status !== 'active') fail('FORBIDDEN');
      const branch = await Branch.findOne({ _id: data.branchId, gymId }).select('_id status').lean();
      if (!branch) fail('BRANCH_NOT_FOUND'); if (branch.status !== 'active') fail('ATTENDANCE_BRANCH_INACTIVE');
      if (String(member.branchId) !== data.branchId.toLowerCase()) fail('ATTENDANCE_BRANCH_MISMATCH');
      const now = new Date(); const date = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
      const subscriptions = await MemberSubscription.find({ gymId, memberId: member._id,
        status: { $ne: 'cancelled' }, startDate: { $lte: date }, endDate: { $gt: date } }).limit(2).lean();
      if (!subscriptions.length) fail('ATTENDANCE_MEMBERSHIP_REQUIRED');
      if (subscriptions.length !== 1 || subscriptions[0].status !== 'active') fail('ATTENDANCE_MEMBERSHIP_AMBIGUOUS');
      const subscription = subscriptions[0];
      // Verify reference tenancy without consulting mutable plan pricing/status for eligibility.
      if (!await MembershipPlan.exists({ _id: subscription.membershipPlanId, gymId })) fail('ATTENDANCE_MEMBERSHIP_REQUIRED');
      if (subscription.previousSubscriptionId && !await MemberSubscription.exists({
        _id: subscription.previousSubscriptionId, gymId, memberId: member._id, endDate: { $lte: subscription.startDate } }))
        fail('ATTENDANCE_MEMBERSHIP_REQUIRED');
      if (await Attendance.exists({ gymId, memberId: member._id, status: 'open' })) fail('ATTENDANCE_ALREADY_OPEN');
      // The partial unique index, not this precheck, is authoritative under concurrency.
      const record = await Attendance.create({ gymId, memberId: member._id, branchId: branch._id,
        subscriptionId: subscription._id, checkInAt: now, status: 'open', recordedByUserId: auth.user._id });
      return dto(record.toObject());
    },
    async checkOut(auth, authorization, attendanceId, input) {
      parse(checkOut, input); const selected = await scope(auth, authorization);
      const previous = await existing(selected, attendanceId); dto(previous);
      if (previous.status !== 'open') fail('ATTENDANCE_NOT_OPEN');
      const now = new Date(); if (now < previous.checkInAt) fail('INVALID_ATTENDANCE_STATE');
      const record = await Attendance.findOneAndUpdate({ _id: previous._id, gymId: selected.gymId, status: 'open',
        checkInAt: { $lte: now } }, { $set: { status: 'completed', checkOutAt: now } }, { returnDocument: 'after', runValidators: true }).lean();
      if (!record) fail('ATTENDANCE_NOT_OPEN'); return dto(record);
    },
    async get(auth, authorization, attendanceId) { return dto(await existing(await scope(auth, authorization), attendanceId)); },
    async list(auth, authorization, query) {
      const selected = await scope(auth, authorization); const { page, limit, memberId, branchId, subscriptionId, status,
        checkInFrom, checkInTo } = parse(attendanceListInput, query);
      const filter = { gymId: new Types.ObjectId(selected.gymId), ...(status ? { status } : {}) };
      for (const [field, value] of Object.entries({ memberId, branchId, subscriptionId })) if (value) filter[field] = new Types.ObjectId(value);
      if (checkInFrom || checkInTo) filter.checkInAt = { ...(checkInFrom ? { $gte: new Date(checkInFrom) } : {}), ...(checkInTo ? { $lte: new Date(checkInTo) } : {}) };
      const [result] = await Attendance.aggregate([{ $match: filter }, ...relationshipStages(selected),
        { $facet: { records: [{ $sort: { checkInAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
      return { data: result.records.map(dto), pagination: { page, limit, total: result.count[0]?.total ?? 0 } };
    },
  };
}
module.exports = { createAttendanceService };
