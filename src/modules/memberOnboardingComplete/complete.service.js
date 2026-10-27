const { createHash } = require('node:crypto');
const { Types } = require('mongoose');
const { completeOnboarding, idempotencyKey } = require('./complete.validation');
const { gymCalendar } = require('../gymDashboard/dashboard.period');

function fail(code) { const error = new Error('Member onboarding failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function pick(value, fields) { return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]])); }
function replay(record, requestDigest) {
  if (record.requestDigest !== requestDigest) fail('IDEMPOTENCY_KEY_CONFLICT');
  if (!record.result || record.result.operationId !== String(record._id)) fail('INVALID_ONBOARDING_STATE');
  return record.result;
}
function resultDto(operationId, member, subscription, payment) {
  const price = subscription?.pricePaiseSnapshot ?? 0; const received = payment?.amountPaise ?? 0;
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(received) || received < 0 || price < received) fail('INVALID_FINANCIAL_STATE');
  // A JSON snapshot makes first delivery and durable replay identical, including dates.
  return JSON.parse(JSON.stringify({ operationId: String(operationId),
    member: pick(member, ['id', 'gymId', 'branchId', 'memberCode', 'firstName', 'lastName', 'status']),
    subscription: subscription ? pick(subscription, ['id', 'membershipPlanId', 'planNameSnapshot', 'durationDaysSnapshot',
      'pricePaiseSnapshot', 'startDate', 'endDate', 'status', 'isCurrentlyActive']) : null,
    payment: payment ? pick(payment, ['id', 'subscriptionId', 'amountPaise', 'paymentMethod', 'paidAt', 'transactionReference']) : null,
    billing: { planPricePaise: price, discountPaise: 0, amountReceivedPaise: received,
      outstandingBalancePaise: Number(BigInt(price) - BigInt(received)) },
  }));
}
function createCompleteOnboardingService({ MemberOnboardingOperation, Gym, GymAccess, UserAccount,
  memberService, subscriptionService, paymentService, authorizationService }) {
  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return current;
  }
  async function lockScope(auth, selected, session) {
    // Share the staff service's real writes to serialize access revocation with this operation.
    const gym = await Gym.findOneAndUpdate({ _id: selected.gymId, status: 'active' }, { $inc: { __v: 1 } },
      { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
    const actor = await GymAccess.findOneAndUpdate({ gymId: selected.gymId, userId: auth.user._id, role: 'admin', status: 'active' },
      { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
    if (!gym || !actor || !await UserAccount.exists({ _id: auth.user._id, status: 'active' }).session(session)) fail('FORBIDDEN');
  }
  return { async complete(auth, authorization, input, key) {
    const selected = await scope(auth, authorization);
    const data = parse(completeOnboarding, input);
    const filter = { gymId: selected.gymId, userId: auth.user._id, keyDigest: digest(parse(idempotencyKey, key)) };
    const requestDigest = digest(JSON.stringify(canonical(data)));
    const existing = await MemberOnboardingOperation.findOne(filter).lean();
    if (existing) return replay(existing, requestDigest);
    const startDate = data.membership?.startDate ?? (await gymCalendar(Gym, selected.gymId)).label;
    const session = await MemberOnboardingOperation.db.startSession();
    try {
      return await session.withTransaction(async () => {
        await lockScope(auth, selected, session);
        // Retry callbacks read the winning operation before performing any domain inserts.
        const committed = await MemberOnboardingOperation.findOne(filter).session(session).lean();
        if (committed) return replay(committed, requestDigest);
        const member = await memberService.onboardForComplete(auth, selected, Object.fromEntries(Object.entries(data.member).filter(([key]) => key !== 'branchId')), session);
        const subscription = data.membership ? await subscriptionService.createForPurchase(auth, selected, {
          memberId: member.id, membershipPlanId: data.membership.planId, startDate }, session) : null;
        const initial = data.membership?.payment;
        const payment = initial?.amountPaise > 0 ? await paymentService.createForPurchase(auth, selected, {
          memberId: member.id, subscriptionId: subscription.id, amountPaise: initial.amountPaise,
          paymentMethod: initial.method, paidAt: initial.paidAt, transactionReference: initial.reference }, session) : null;
        const operationId = new Types.ObjectId();
        const result = resultDto(operationId, data.member.branchId ? { ...member, branchId: data.member.branchId } : member, subscription, payment);
        await MemberOnboardingOperation.create([{ _id: operationId, ...filter, requestDigest, result }], { session });
        return result;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('ONBOARDING_STORAGE_UNAVAILABLE');
      if (error.code === 11000 && error.keyPattern?.keyDigest) {
        const committed = await MemberOnboardingOperation.findOne(filter).lean();
        if (committed) return replay(committed, requestDigest);
      }
      throw error;
    } finally { await session.endSession(); }
  } };
}
module.exports = { createCompleteOnboardingService };
