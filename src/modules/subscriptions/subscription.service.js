const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { createPlan } = require('../membershipPlans/plan.validation');
const { today, calendarDate, createSubscription, cancelSubscription, subscriptionListInput } = require('./subscription.validation');
function fail(code) { const error = new Error('Subscription operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data;
}
function midnight() { return new Date(`${today()}T00:00:00.000Z`); }
function dto(record, now = midnight()) {
  if (record.startDate > now || !['active', 'expired', 'cancelled'].includes(record.status)) fail('INVALID_SUBSCRIPTION_STATE');
  return { id: String(record._id), gymId: String(record.gymId), memberId: String(record.memberId),
    membershipPlanId: String(record.membershipPlanId), startDate: record.startDate.toISOString().slice(0, 10),
    endDate: record.endDate.toISOString().slice(0, 10),
    status: record.status === 'cancelled' ? 'cancelled' : record.endDate <= now ? 'expired' : 'active',
    planNameSnapshot: record.planNameSnapshot, durationDaysSnapshot: record.durationDaysSnapshot,
    pricePaiseSnapshot: record.pricePaiseSnapshot, notes: record.notes, cancelledAt: record.cancelledAt,
    cancellationReason: record.cancellationReason, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function createSubscriptionService({ MemberSubscription, MemberProfile, MembershipPlan, TrainerProfile, TrainerMemberAssignment, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId); return current;
  }
  async function readScope(auth, authorization) {
    const current = await scope(auth, authorization, ['admin', 'trainer']);
    if (current.role === 'admin') return { gymId: current.gymId };
    const trainers = await TrainerProfile.find({ userId: auth.user._id, gymId: current.gymId, status: 'active' }).select('_id').limit(2).lean();
    if (trainers.length !== 1) fail('FORBIDDEN');
    return { gymId: current.gymId, trainerId: trainers[0]._id };
  }
  function relationshipStages(selected) {
    const gymId = new Types.ObjectId(selected.gymId);
    const stages = [[MemberProfile, 'memberId', 'member'], [MembershipPlan, 'membershipPlanId', 'plan']].flatMap(([model, field, alias]) => [
      { $lookup: { from: model.collection.name, localField: field, foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: alias } }, { $unwind: `$${alias}` },
    ]);
    if (selected.trainerId) stages.push(
      { $lookup: { from: TrainerMemberAssignment.collection.name, localField: 'memberId', foreignField: 'memberId',
        pipeline: [{ $match: { gymId, trainerId: selected.trainerId, status: 'active' } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'assignment' } },
      { $match: { 'assignment.0': { $exists: true } } },
    );
    return stages;
  }
  async function existing(selected, subscriptionId) {
    const records = await MemberSubscription.aggregate([
      { $match: { _id: new Types.ObjectId(parse(objectId, subscriptionId)), gymId: new Types.ObjectId(selected.gymId) } },
      ...relationshipStages(selected),
    ]);
    if (!records.length) fail('SUBSCRIPTION_NOT_FOUND'); return records[0];
  }
  return {
    async authorizeRead(auth, authorization, subscriptionId) {
      const selected = await readScope(auth, authorization);
      if (subscriptionId !== undefined) await existing(selected, subscriptionId);
    },
    async create(auth, authorization, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      const data = parse(createSubscription, input);
      const session = await MemberSubscription.db.startSession();
      try {
        return await session.withTransaction(async () => {
          // Serialize creation for this member using its existing version field.
          // Real writes conflict across concurrent transactions; no-op writes do not suffice.
          const member = await MemberProfile.findOneAndUpdate({ _id: data.memberId, gymId },
            { $inc: { __v: 1 } }, { session, returnDocument: 'after', timestamps: false }).select('_id status').lean();
          if (!member) fail('MEMBER_NOT_FOUND'); if (member.status !== 'active') fail('FORBIDDEN');
          const plan = await MembershipPlan.findOne({ _id: data.membershipPlanId, gymId }).session(session).lean();
          if (!plan) fail('PLAN_NOT_FOUND'); if (plan.status !== 'active') fail('FORBIDDEN');
          // Fail safely if direct database writes introduced invalid commercial terms.
          parse(createPlan, { name: plan.name, durationDays: plan.durationDays, price: plan.price, status: plan.status });
          const startDate = new Date(`${data.startDate}T00:00:00.000Z`);
          const endDate = new Date(startDate); endDate.setUTCDate(endDate.getUTCDate() + plan.durationDays);
          parse(calendarDate, endDate.toISOString().slice(0, 10));
          const overlap = await MemberSubscription.exists({ gymId, memberId: data.memberId, status: { $ne: 'cancelled' },
            startDate: { $lt: endDate }, endDate: { $gt: startDate } }).session(session);
          if (overlap) fail('SUBSCRIPTION_OVERLAP');
          const [record] = await MemberSubscription.create([{ gymId, memberId: data.memberId, membershipPlanId: data.membershipPlanId,
            startDate, endDate, planNameSnapshot: plan.name, durationDaysSnapshot: plan.durationDays,
            pricePaiseSnapshot: plan.price, status: endDate <= midnight() ? 'expired' : 'active', notes: data.notes }], { session });
          return dto(record.toObject());
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } catch (error) {
        if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
        throw error;
      } finally { await session.endSession(); }
    },
    async get(auth, authorization, subscriptionId) { return dto(await existing(await readScope(auth, authorization), subscriptionId)); },
    async list(auth, authorization, query) {
      const selected = await readScope(auth, authorization);
      const { page, limit, status, memberId, membershipPlanId } = parse(subscriptionListInput, query);
      const now = midnight();
      const filter = { gymId: new Types.ObjectId(selected.gymId),
        ...(memberId ? { memberId: new Types.ObjectId(memberId) } : {}),
        ...(membershipPlanId ? { membershipPlanId: new Types.ObjectId(membershipPlanId) } : {}) };
      if (status === 'cancelled') filter.status = 'cancelled';
      else if (status) {
        filter.status = { $ne: 'cancelled' }; filter.endDate = status === 'expired' ? { $lte: now } : { $gt: now };
        if (status === 'active') filter.startDate = { $lte: now };
      }
      const [result] = await MemberSubscription.aggregate([{ $match: filter }, ...relationshipStages(selected),
        { $facet: { records: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
      return { data: result.records.map((record) => dto(record, now)), pagination: { page, limit, total: result.count[0]?.total ?? 0 } };
    },
    async cancel(auth, authorization, subscriptionId, input) {
      const selected = await scope(auth, authorization, ['admin']); const data = parse(cancelSubscription, input);
      await existing(selected, subscriptionId);
      const record = await MemberSubscription.findOneAndUpdate({ _id: subscriptionId, gymId: selected.gymId, status: { $ne: 'cancelled' } },
        { $set: { status: 'cancelled', cancelledAt: new Date(), ...data } }, { returnDocument: 'after', runValidators: true }).lean();
      return dto(record || await existing(selected, subscriptionId));
    },
  };
}
module.exports = { createSubscriptionService };
