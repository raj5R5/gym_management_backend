const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { createPayment, paymentListInput } = require('./payment.validation');
function fail(code) { const error = new Error('Payment operation failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function money(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE_PAISE) fail('INVALID_FINANCIAL_STATE');
  return BigInt(value);
}
function exactTotal(value) {
  let amount;
  try { amount = BigInt(value?.toString() ?? '0'); } catch { fail('INVALID_FINANCIAL_STATE'); }
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_FINANCIAL_STATE');
  return Number(amount);
}
function dto(record) {
  return { id: String(record._id), gymId: String(record.gymId), memberId: String(record.memberId),
    subscriptionId: String(record.subscriptionId), amountPaise: record.amountPaise, status: record.status,
    paymentMethod: record.paymentMethod, paidAt: record.paidAt, transactionReference: record.transactionReference,
    notes: record.notes, recordedByUserId: record.recordedByUserId ? String(record.recordedByUserId) : undefined,
    createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function createPaymentService({ Payment, MemberSubscription, MemberProfile, TrainerProfile, TrainerMemberAssignment, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId); return current;
  }
  async function readScope(auth, authorization) {
    const current = await scope(auth, authorization, ['admin', 'trainer']);
    if (current.role === 'admin') return { gymId: current.gymId };
    const profiles = await TrainerProfile.find({ userId: auth.user._id, gymId: current.gymId, status: 'active' }).select('_id').limit(2).lean();
    if (profiles.length !== 1) fail('FORBIDDEN'); return { gymId: current.gymId, trainerId: profiles[0]._id };
  }
  function relationshipStages(selected) {
    const gymId = new Types.ObjectId(selected.gymId);
    const stages = [
      { $lookup: { from: MemberProfile.collection.name, localField: 'memberId', foreignField: '_id',
        pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'member' } }, { $unwind: '$member' },
      { $lookup: { from: MemberSubscription.collection.name, let: { subscriptionId: '$subscriptionId', memberId: '$memberId' },
        pipeline: [{ $match: { gymId, $expr: { $and: [{ $eq: ['$_id', '$$subscriptionId'] }, { $eq: ['$memberId', '$$memberId'] }] } } },
          { $project: { _id: 1 } }], as: 'subscription' } }, { $unwind: '$subscription' },
    ];
    if (selected.trainerId) stages.push(
      { $lookup: { from: TrainerMemberAssignment.collection.name, localField: 'memberId', foreignField: 'memberId',
        pipeline: [{ $match: { gymId, trainerId: selected.trainerId, status: 'active' } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'assignment' } },
      { $match: { 'assignment.0': { $exists: true } } },
    );
    return stages;
  }
  async function existing(selected, paymentId) {
    const records = await Payment.aggregate([{ $match: { gymId: new Types.ObjectId(selected.gymId), _id: new Types.ObjectId(parse(objectId, paymentId)) } },
      ...relationshipStages(selected)]);
    if (!records.length) fail('PAYMENT_NOT_FOUND'); return records[0];
  }
  function validatedPayment(input, gymId, recordedByUserId) {
    const data = parse(createPayment, input);
    if (['upi', 'bank_transfer', 'card'].includes(data.paymentMethod) && !data.transactionReference) fail('VALIDATION_ERROR');
    if (data.transactionReference && [gymId, data.memberId, data.subscriptionId, recordedByUserId]
      .some((id) => id.toLowerCase() === data.transactionReference.toLowerCase())) fail('VALIDATION_ERROR');
    return data;
  }
  async function insertPayment(gymId, data, recordedByUserId, session) {
    // A real version write serializes payment creation and conflicts with cancellation.
    const subscription = await MemberSubscription.findOneAndUpdate({ _id: data.subscriptionId, gymId },
      { $inc: { __v: 1 } }, { session, returnDocument: 'after', timestamps: false }).lean();
    if (!subscription) fail('SUBSCRIPTION_NOT_FOUND');
    if (String(subscription.memberId) !== data.memberId.toLowerCase()) fail('PAYMENT_MEMBER_MISMATCH');
    if (!['active', 'expired', 'cancelled'].includes(subscription.status)) fail('INVALID_FINANCIAL_STATE');
    if (subscription.status === 'cancelled') fail('PAYMENT_SUBSCRIPTION_CANCELLED');
    const member = await MemberProfile.findOne({ _id: data.memberId, gymId }).session(session).select('_id').lean();
    if (!member) fail('MEMBER_NOT_FOUND');
    const price = money(subscription.pricePaiseSnapshot);
    const payments = await Payment.find({ gymId, subscriptionId: data.subscriptionId, status: 'succeeded' })
      .session(session).select('amountPaise memberId').lean();
    if (payments.some((payment) => String(payment.memberId) !== String(subscription.memberId))) fail('INVALID_FINANCIAL_STATE');
    const collected = payments.reduce((sum, payment) => sum + money(payment.amountPaise), 0n);
    if (money(data.amountPaise) > price - collected) fail('PAYMENT_OVERPAYMENT');
    const [record] = await Payment.create([{ ...data, gymId, status: 'succeeded', recordedByUserId }], { session });
    return dto(record.toObject());
  }
  return {
    async summariesForMemberships(auth, authorization, memberId, subscriptions) {
      const selected = await readScope(auth, authorization); const id = parse(objectId, memberId);
      if (!Array.isArray(subscriptions) || subscriptions.length > 101) fail('VALIDATION_ERROR');
      if (selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId, trainerId: selected.trainerId, memberId: id, status: 'active' })) fail('MEMBER_NOT_FOUND');
      if (!await MemberProfile.exists({ _id: id, gymId: selected.gymId })) fail('MEMBER_NOT_FOUND');
      const ids = [...new Set(subscriptions.map((record) => parse(objectId, record.id)))];
      if (!ids.length) return {};
      const records = await MemberSubscription.find({ gymId: selected.gymId, memberId: id, _id: { $in: ids } }).select('_id pricePaiseSnapshot').lean();
      if (records.length !== ids.length) fail('SUBSCRIPTION_NOT_FOUND');
      const totals = await Payment.aggregate([{ $match: { gymId: new Types.ObjectId(selected.gymId),
        subscriptionId: { $in: ids.map((value) => new Types.ObjectId(value)) }, status: 'succeeded' } },
        { $set: { valid: { $cond: [{ $isNumber: '$amountPaise' }, { $and: [{ $gt: ['$amountPaise', 0] },
          { $lte: ['$amountPaise', MAX_PRICE_PAISE] }, { $eq: ['$amountPaise', { $trunc: '$amountPaise' }] },
          { $eq: ['$memberId', new Types.ObjectId(id)] }] }, false] } } },
        { $group: { _id: '$subscriptionId', amount: { $sum: { $convert: { input: '$amountPaise', to: 'decimal', onError: 0, onNull: 0 } } },
          invalid: { $sum: { $cond: ['$valid', 0, 1] } } } }]);
      if (totals.some((record) => record.invalid)) fail('INVALID_FINANCIAL_STATE');
      const amounts = new Map(totals.map((record) => [String(record._id), BigInt(exactTotal(record.amount))]));
      return Object.fromEntries(records.map((record) => {
        const price = money(record.pricePaiseSnapshot); const paid = amounts.get(String(record._id)) ?? 0n;
        if (paid > price) fail('INVALID_FINANCIAL_STATE');
        return [String(record._id), { totalSuccessfulPaidPaise: Number(paid), remainingBalancePaise: Number(price - paid) }];
      }));
    },
    async authorizeRead(auth, authorization, paymentId) {
      const selected = await readScope(auth, authorization); if (paymentId !== undefined) await existing(selected, paymentId);
    },
    async create(auth, authorization, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      const recordedByUserId = String(auth.user._id); const data = validatedPayment(input, gymId, recordedByUserId);
      const session = await Payment.db.startSession();
      try {
        return await session.withTransaction(async () => {
          return insertPayment(gymId, data, recordedByUserId, session);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } catch (error) {
        if (error.code === 20 || error.originalError?.code === 20) fail('PAYMENT_STORAGE_UNAVAILABLE');
        throw error;
      } finally { await session.endSession(); }
    },
    async createForPurchase(auth, authorization, input, session) {
      if (!session?.inTransaction() || session.client !== Payment.db.getClient()) fail('INVALID_TRANSACTION_CONTEXT');
      const selected = await readScope(auth, authorization); const recordedByUserId = String(auth.user._id);
      const data = validatedPayment(input, selected.gymId, recordedByUserId);
      if (selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId,
        trainerId: selected.trainerId, memberId: data.memberId, status: 'active' }).session(session)) fail('MEMBER_NOT_FOUND');
      return insertPayment(selected.gymId, data, recordedByUserId, session);
    },
    async get(auth, authorization, paymentId) { return dto(await existing(await readScope(auth, authorization), paymentId)); },
    async list(auth, authorization, query) {
      const selected = await readScope(auth, authorization);
      const { page, limit, memberId, subscriptionId, status, paymentMethod, paidFrom, paidTo } = parse(paymentListInput, query);
      const filter = { gymId: new Types.ObjectId(selected.gymId), ...(memberId ? { memberId: new Types.ObjectId(memberId) } : {}),
        ...(subscriptionId ? { subscriptionId: new Types.ObjectId(subscriptionId) } : {}), ...(status ? { status } : {}), ...(paymentMethod ? { paymentMethod } : {}) };
      if (paidFrom || paidTo) filter.paidAt = { ...(paidFrom ? { $gte: new Date(paidFrom) } : {}), ...(paidTo ? { $lte: new Date(paidTo) } : {}) };
      const [result] = await Payment.aggregate([{ $match: filter }, ...relationshipStages(selected),
        { $facet: { records: [{ $sort: { paidAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
      return { data: result.records.map(dto), pagination: { page, limit, total: result.count[0]?.total ?? 0 } };
    },
  };
}
module.exports = { createPaymentService, exactTotal };
