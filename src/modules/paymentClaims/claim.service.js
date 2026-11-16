const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { objectId } = require('../gyms/gym.validation');
const { classify } = require('../memberOverview/overview.service');
const schemas = require('./claim.validation');

function fail(code) { const error = new Error('Payment claim failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const id = (value) => new Types.ObjectId(parse(objectId, String(value)));
const dto = (claim) => ({ id: String(claim._id), amountPaise: claim.amountPaise, reference: claim.reference, status: claim.status,
  createdAt: claim.createdAt, decidedAt: claim.decidedAt ?? null, rejectReason: claim.rejectReason ?? null,
  paymentId: claim.paymentId ? String(claim.paymentId) : null });

/**
 * Members report a UPI payment; the owner confirms it into a real Payment or rejects it.
 * Confirmation reuses the payment service inside one transaction, so overpayment and
 * cancelled-membership checks are the same as a payment recorded at the desk.
 */
function createPaymentClaimService({ Gym, PaymentClaim, MemberSubscription, Payment, MemberProfile, paymentService,
  authorizationService, resolveSelfMember }) {
  let indexes;
  const ensureIndexes = () => (indexes ??= PaymentClaim.createIndexes().catch((error) => { indexes = undefined; throw error; }));
  async function adminScope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return new Types.ObjectId(current.gymId);
  }
  // What the member can still claim against their oldest unpaid membership.
  async function claimable(gymId, memberId) {
    const today = (await gymCalendar(Gym, gymId)).day;
    const subscriptions = await MemberSubscription.find({ gymId, memberId, status: { $ne: 'cancelled' } })
      .select('membershipPlanId planNameSnapshot pricePaiseSnapshot startDate endDate').lean();
    const paid = new Map((await Payment.aggregate([{ $match: { gymId, memberId, status: 'succeeded' } },
      { $group: { _id: '$subscriptionId', amount: { $sum: '$amountPaise' } } }])).map((row) => [String(row._id), row.amount]));
    const { dueSubscriptionId } = classify(subscriptions, paid, today);
    if (!dueSubscriptionId) return { subscriptionId: null, availablePaise: 0 };
    const due = subscriptions.find((sub) => String(sub._id) === dueSubscriptionId);
    const pending = await PaymentClaim.aggregate([{ $match: { gymId, subscriptionId: due._id, status: 'pending' } },
      { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]);
    return { subscriptionId: due._id,
      availablePaise: Math.max(0, due.pricePaiseSnapshot - (paid.get(dueSubscriptionId) ?? 0) - (pending[0]?.amount ?? 0)) };
  }

  return {
    async create(auth, authorization, body) {
      const member = await resolveSelfMember(auth, authorization);
      const input = parse(schemas.createClaim, body);
      const gymId = new Types.ObjectId(member.gymId);
      const { subscriptionId, availablePaise } = await claimable(gymId, member._id);
      if (!subscriptionId || input.amountPaise > availablePaise) fail('CLAIM_EXCEEDS_DUE');
      await ensureIndexes();
      try {
        return dto((await PaymentClaim.create({ gymId, memberId: member._id, subscriptionId, amountPaise: input.amountPaise,
          reference: input.reference, createdByUserId: auth.user._id })).toObject());
      } catch (error) {
        if (error?.code === 11000) fail('DUPLICATE_CLAIM_REFERENCE');
        throw error;
      }
    },
    async mine(auth, authorization) {
      const member = await resolveSelfMember(auth, authorization);
      const rows = await PaymentClaim.find({ gymId: member.gymId, memberId: member._id }).sort({ createdAt: -1 }).limit(10).lean();
      return rows.map(dto);
    },
    async list(auth, authorization, query) {
      const gymId = await adminScope(auth, authorization);
      const { status } = parse(schemas.claimListQuery, query);
      const rows = await PaymentClaim.find({ gymId, status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(100).lean();
      const [members, subscriptions] = await Promise.all([
        MemberProfile.find({ gymId, _id: { $in: rows.map((row) => row.memberId) } }).select('memberCode firstName lastName phone').lean(),
        MemberSubscription.find({ gymId, _id: { $in: rows.map((row) => row.subscriptionId) } }).select('planNameSnapshot').lean()]);
      const people = new Map(members.map((m) => [String(m._id), m]));
      const plans = new Map(subscriptions.map((s) => [String(s._id), s.planNameSnapshot]));
      return rows.map((row) => {
        const m = people.get(String(row.memberId));
        return { ...dto(row), planName: plans.get(String(row.subscriptionId)) ?? null,
          member: m ? { id: String(m._id), memberCode: m.memberCode, name: `${m.firstName} ${m.lastName}`, phone: m.phone } : null };
      });
    },
    async confirm(auth, authorization, claimId) {
      const gymId = await adminScope(auth, authorization);
      const session = await Payment.db.startSession();
      try {
        return await session.withTransaction(async () => {
          const claim = await PaymentClaim.findOneAndUpdate({ _id: id(claimId), gymId, status: 'pending' },
            { status: 'confirmed', decidedByUserId: auth.user._id, decidedAt: new Date() },
            { session, returnDocument: 'after', runValidators: true }).lean();
          if (!claim) fail(await PaymentClaim.exists({ _id: id(claimId), gymId }) ? 'CLAIM_ALREADY_DECIDED' : 'CLAIM_NOT_FOUND');
          const payment = await paymentService.createForPurchase(auth, authorization, { memberId: String(claim.memberId),
            subscriptionId: String(claim.subscriptionId), amountPaise: claim.amountPaise, paymentMethod: 'upi',
            paidAt: claim.createdAt.toISOString(), transactionReference: claim.reference }, session);
          await PaymentClaim.updateOne({ _id: claim._id, gymId }, { paymentId: payment.id }, { session });
          return { ...dto({ ...claim, paymentId: payment.id }), payment };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } finally { await session.endSession(); }
    },
    async reject(auth, authorization, claimId, body) {
      const gymId = await adminScope(auth, authorization);
      const { reason } = parse(schemas.rejectClaim, body);
      const claim = await PaymentClaim.findOneAndUpdate({ _id: id(claimId), gymId, status: 'pending' },
        { status: 'rejected', rejectReason: reason, decidedByUserId: auth.user._id, decidedAt: new Date() },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!claim) fail(await PaymentClaim.exists({ _id: id(claimId), gymId }) ? 'CLAIM_ALREADY_DECIDED' : 'CLAIM_NOT_FOUND');
      return dto(claim);
    },
    async pendingCount(gymId) { return PaymentClaim.countDocuments({ gymId, status: 'pending' }); },
  };
}
module.exports = { createPaymentClaimService };
