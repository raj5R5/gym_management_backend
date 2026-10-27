const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { createPlan } = require('../membershipPlans/plan.validation');
const { calendarDate, createSubscription, renewSubscription, renewalPurchase, renewalPreviewQuery, cancelSubscription, subscriptionListInput } = require('./subscription.validation');
function fail(code) { const error = new Error('Subscription operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data;
}
function dto(record, now) {
  if (!['active', 'expired', 'cancelled'].includes(record.status)) fail('INVALID_SUBSCRIPTION_STATE');
  return { id: String(record._id), gymId: String(record.gymId), memberId: String(record.memberId),
    previousSubscriptionId: record.previousSubscriptionId ? String(record.previousSubscriptionId) : null,
    isCurrentlyActive: record.status !== 'cancelled' && record.startDate <= now && record.endDate > now,
    membershipPlanId: String(record.membershipPlanId), startDate: record.startDate.toISOString().slice(0, 10),
    endDate: record.endDate.toISOString().slice(0, 10),
    status: record.status === 'cancelled' ? 'cancelled' : record.endDate <= now ? 'expired' : 'active',
    planNameSnapshot: record.planNameSnapshot, durationDaysSnapshot: record.durationDaysSnapshot,
    pricePaiseSnapshot: record.pricePaiseSnapshot, notes: record.notes, cancelledAt: record.cancelledAt,
    cancellationReason: record.cancellationReason, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function createSubscriptionService({ Gym, MemberSubscription, MemberProfile, MembershipPlan, TrainerProfile, TrainerMemberAssignment, authorizationService, clock = () => new Date() }) {
  const calendar = (gymId, session) => gymCalendar(Gym ?? MemberSubscription.db.models.Gym, gymId, clock(), session);
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
    stages.push(
      { $lookup: { from: MemberSubscription.collection.name,
        let: { previousId: '$previousSubscriptionId', memberId: '$memberId', startDate: '$startDate' },
        pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$previousId'] },
          { $eq: ['$memberId', '$$memberId'] }, { $lte: ['$endDate', '$$startDate'] }] } } }, { $project: { _id: 1 } }], as: 'predecessor' } },
      { $match: { $or: [{ previousSubscriptionId: { $exists: false } }, { previousSubscriptionId: null },
        { 'predecessor.0': { $exists: true } }] } },
    );
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
  async function transaction(work) {
    const session = await MemberSubscription.db.startSession();
    try {
      return await session.withTransaction(() => work(session),
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
      throw error;
    } finally { await session.endSession(); }
  }
  async function lockMember(gymId, memberId, session) {
    // A real version write serializes all creation/renewal paths across processes.
    const member = await MemberProfile.findOneAndUpdate({ _id: memberId, gymId },
      { $inc: { __v: 1 } }, { session, returnDocument: 'after', timestamps: false }).select('_id status').lean();
    if (!member) fail('MEMBER_NOT_FOUND'); if (member.status !== 'active') fail('FORBIDDEN');
  }
  async function requireNoUnexpiredMembership(gymId, memberId, session) {
    // Lifecycle is date-derived, just like dto/list: future periods are also
    // unexpired. This read runs AFTER the shared member version write for every
    // creation path, so competing transactions retry against the winner's state.
    if (await MemberSubscription.exists({ gymId, memberId, status: { $ne: 'cancelled' },
      endDate: { $gt: (await calendar(gymId, session)).day } }).session(session)) fail('ACTIVE_MEMBERSHIP_EXISTS');
  }
  async function currentPlan(gymId, planId, session) {
    const plan = await MembershipPlan.findOne({ _id: planId, gymId }).session(session).lean();
    if (!plan) fail('PLAN_NOT_FOUND'); if (plan.status !== 'active') fail('FORBIDDEN');
    parse(createPlan, { name: plan.name, durationDays: plan.durationDays, price: plan.price, status: plan.status });
    return plan;
  }
  function period(plan, start) {
    const startDate = new Date(`${parse(calendarDate, start)}T00:00:00.000Z`);
    const endDate = new Date(startDate); endDate.setUTCDate(endDate.getUTCDate() + plan.durationDays);
    parse(calendarDate, endDate.toISOString().slice(0, 10));
    return { startDate, endDate };
  }
  async function renewalContext(gymId, previous, data, session) {
    dto(previous, (await calendar(gymId, session)).day);
    if (previous.status === 'cancelled') fail('SUBSCRIPTION_CANCELLED');
    if (previous.previousSubscriptionId && !await MemberSubscription.exists({ _id: previous.previousSubscriptionId, gymId,
      memberId: previous.memberId, endDate: { $lte: previous.startDate } }).session(session)) fail('SUBSCRIPTION_NOT_FOUND');
    if (await MemberSubscription.exists({ gymId, previousSubscriptionId: previous._id }).session(session)) fail('SUBSCRIPTION_ALREADY_RENEWED');
    const member = await MemberProfile.findOne({ _id: previous.memberId, gymId }).session(session).lean();
    if (!member) fail('MEMBER_NOT_FOUND'); if (member.status !== 'active') fail('FORBIDDEN');
    const plan = await currentPlan(gymId, data.planId ?? previous.membershipPlanId, session);
    const previousEnd = previous.endDate.toISOString().slice(0, 10);
    const currentDay = (await calendar(gymId, session)).label;
    const start = data.startDate ?? (previousEnd > currentDay ? previousEnd : currentDay);
    if (start < previousEnd) fail('SUBSCRIPTION_OVERLAP');
    await requireNoUnexpiredMembership(gymId, previous.memberId, session);
    const dates = period(plan, start);
    const overlap = await MemberSubscription.exists({ gymId, memberId: previous.memberId, status: { $ne: 'cancelled' },
      startDate: { $lt: dates.endDate }, endDate: { $gt: dates.startDate } }).session(session);
    if (overlap) fail('SUBSCRIPTION_OVERLAP');
    const terms = { planName: plan.name, durationDays: plan.durationDays, pricePaise: plan.price,
      startDate: start, endDate: dates.endDate.toISOString().slice(0, 10) };
    return { member, plan, dates, terms };
  }
  async function insertPeriod(gymId, data, session, selectedPlan) {
    const plan = selectedPlan ?? await currentPlan(gymId, data.membershipPlanId, session);
    await requireNoUnexpiredMembership(gymId, data.memberId, session);
    const { label, day } = await calendar(gymId, session);
    if (!selectedPlan && data.startDate > label) fail('VALIDATION_ERROR');
    const { startDate, endDate } = period(plan, data.startDate);
    const overlap = await MemberSubscription.exists({ gymId, memberId: data.memberId, status: { $ne: 'cancelled' },
      startDate: { $lt: endDate }, endDate: { $gt: startDate } }).session(session);
    if (overlap) fail('SUBSCRIPTION_OVERLAP');
    const [record] = await MemberSubscription.create([{ gymId, memberId: data.memberId, membershipPlanId: data.membershipPlanId,
      previousSubscriptionId: data.previousSubscriptionId, startDate, endDate, planNameSnapshot: plan.name,
      durationDaysSnapshot: plan.durationDays, pricePaiseSnapshot: plan.price,
      status: endDate <= day ? 'expired' : 'active', notes: data.notes }], { session });
    return dto(record.toObject(), day);
  }
  async function renewInSession(gymId, id, data, session) {
    const previous = await MemberSubscription.findOne({ _id: id, gymId }).session(session).lean();
    if (!previous) fail('SUBSCRIPTION_NOT_FOUND');
    dto(previous, (await calendar(gymId, session)).day); // Unknown lifecycle states must never authorize a renewal.
    await lockMember(gymId, previous.memberId, session);
    // Conflict with cancellation/payment writes without changing historical terms or timestamps.
    const locked = await MemberSubscription.findOneAndUpdate({ _id: id, gymId },
      { $inc: { __v: 1 } }, { session, returnDocument: 'after', timestamps: false });
    if (!locked) fail('SUBSCRIPTION_NOT_FOUND');
    const context = await renewalContext(gymId, previous, data, session);
    if (data.expectedTerms && Object.entries(context.terms).some(([key, value]) => data.expectedTerms[key] !== value)) {
      fail('RENEWAL_PREVIEW_CHANGED');
    }
    const startDate = context.terms.startDate;
    return insertPeriod(gymId, { memberId: previous.memberId, membershipPlanId: context.plan._id,
      previousSubscriptionId: previous._id, startDate, notes: data.notes }, session, context.plan);
  }
  async function cancelRecord(selected, subscriptionId, data) {
    const record = await MemberSubscription.findOneAndUpdate({ _id: subscriptionId, gymId: selected.gymId, ...(selected.memberId ? { memberId: selected.memberId } : {}), status: { $ne: 'cancelled' } },
      { $set: { status: 'cancelled', cancelledAt: new Date(), ...data } }, { returnDocument: 'after', runValidators: true }).lean();
    const result = record || await existing(selected, subscriptionId);
    if (selected.memberId && String(result.memberId) !== selected.memberId) fail('SUBSCRIPTION_NOT_FOUND');
    return dto(result, (await calendar(selected.gymId)).day);
  }
  return {
    async authorizeRead(auth, authorization, subscriptionId) {
      const selected = await readScope(auth, authorization);
      if (subscriptionId !== undefined) await existing(selected, subscriptionId);
    },
    async create(auth, authorization, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      const data = parse(createSubscription, input);
      return transaction(async (session) => {
        await lockMember(gymId, data.memberId, session);
        return insertPeriod(gymId, data, session);
      });
    },
    async createForPurchase(auth, authorization, input, session) {
      if (!session?.inTransaction() || session.client !== MemberSubscription.db.getClient()) fail('INVALID_TRANSACTION_CONTEXT');
      const selected = await readScope(auth, authorization); const data = parse(createSubscription, input);
      if (selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId,
        trainerId: selected.trainerId, memberId: data.memberId, status: 'active' }).session(session)) fail('MEMBER_NOT_FOUND');
      await lockMember(selected.gymId, data.memberId, session);
      return insertPeriod(selected.gymId, data, session);
    },
    async renewalPreview(auth, authorization, subscriptionId, query = {}) {
      const { gymId } = await scope(auth, authorization, ['admin']); const id = parse(objectId, subscriptionId);
      return transaction(async (session) => {
        const previous = await MemberSubscription.findOne({ _id: id, gymId }).session(session).lean();
        if (!previous) fail('SUBSCRIPTION_NOT_FOUND');
        const { member, plan, terms } = await renewalContext(gymId, previous, parse(renewalPreviewQuery, query), session);
        return { gymId: String(gymId), subscriptionId: String(previous._id),
          member: { id: String(member._id), firstName: member.firstName, lastName: member.lastName, memberCode: member.memberCode },
          planId: String(plan._id), previousEndDate: previous.endDate.toISOString().slice(0, 10),
          calendarTimezone: (await calendar(gymId, session)).timezone, terms, initialPaymentPaise: 0, outstandingBalancePaise: terms.pricePaise };
      });
    },
    async renew(auth, authorization, subscriptionId, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      const id = parse(objectId, subscriptionId); const data = parse(renewSubscription, input);
      return transaction((session) => renewInSession(gymId, id, data, session));
    },
    async renewForPurchase(auth, authorization, subscriptionId, input, session) {
      if (!session?.inTransaction() || session.client !== MemberSubscription.db.getClient()) fail('INVALID_TRANSACTION_CONTEXT');
      const { gymId } = await scope(auth, authorization, ['admin']);
      return renewInSession(gymId, parse(objectId, subscriptionId), parse(renewalPurchase, input), session);
    },
    async get(auth, authorization, subscriptionId) { const selected = await readScope(auth, authorization); return dto(await existing(selected, subscriptionId), (await calendar(selected.gymId)).day); },
    async list(auth, authorization, query) {
      const selected = await readScope(auth, authorization);
      const { page, limit, status, memberId, membershipPlanId } = parse(subscriptionListInput, query);
      const { day: now } = await calendar(selected.gymId);
      const filter = { gymId: new Types.ObjectId(selected.gymId),
        ...(memberId ? { memberId: new Types.ObjectId(memberId) } : {}),
        ...(membershipPlanId ? { membershipPlanId: new Types.ObjectId(membershipPlanId) } : {}) };
      if (status === 'cancelled') filter.status = 'cancelled';
      else if (status) {
        filter.status = { $ne: 'cancelled' }; filter.endDate = status === 'expired' ? { $lte: now } : { $gt: now };
      }
      const [result] = await MemberSubscription.aggregate([{ $match: filter }, ...relationshipStages(selected),
        { $facet: { records: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
      return { data: result.records.map((record) => dto(record, now)), pagination: { page, limit, total: result.count[0]?.total ?? 0 } };
    },
    async cancelForMember(auth, authorization, memberId, subscriptionId, input) {
      const selected = await readScope(auth, authorization); const member = parse(objectId, memberId); const data = parse(cancelSubscription, input);
      if (selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId, trainerId: selected.trainerId, memberId: member, status: 'active' })) fail('MEMBER_NOT_FOUND');
      if (!await MemberProfile.exists({ _id: member, gymId: selected.gymId })) fail('MEMBER_NOT_FOUND');
      const record = await existing(selected, subscriptionId);
      if (String(record.memberId) !== member.toLowerCase()) fail('SUBSCRIPTION_NOT_FOUND');
      return cancelRecord({ ...selected, memberId: member.toLowerCase() }, subscriptionId, data);
    },
    async cancel(auth, authorization, subscriptionId, input) {
      const selected = await scope(auth, authorization, ['admin']); const data = parse(cancelSubscription, input);
      await existing(selected, subscriptionId);
      return cancelRecord(selected, subscriptionId, data);
    },
  };
}
module.exports = { createSubscriptionService };
