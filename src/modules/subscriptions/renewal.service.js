const { createHash } = require('node:crypto');
const { renewalPurchase } = require('./subscription.validation');
const { idempotencyKey } = require('../memberOnboardingComplete/complete.validation');
const { objectId } = require('../gyms/gym.validation');
function fail(code) { const error = new Error('Renewal could not be completed.'); error.code = code; throw error; }
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const digest = (value) => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function createRenewalService({ RenewalOperation, subscriptionService, paymentService, authorizationService }) {
  return { async complete(auth, authorization, subscriptionId, input, key) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const selected = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, selected, ['admin'], authorization.gymId);
    const id = parse(objectId, subscriptionId).toLowerCase(); const data = parse(renewalPurchase, input);
    data.planId = data.planId.toLowerCase();
    if (data.payment) data.payment.paidAt = new Date(data.payment.paidAt).toISOString();
    const filter = { gymId: selected.gymId, userId: auth.user._id, keyDigest: digest(parse(idempotencyKey, key)) };
    const requestDigest = digest(JSON.stringify(canonical({ subscriptionId: id, ...data })));
    function replay(record) {
      if (record.requestDigest !== requestDigest || String(record.subscriptionId) !== id) fail('IDEMPOTENCY_KEY_CONFLICT');
      return JSON.parse(record.resultJson);
    }
    const existing = await RenewalOperation.findOne(filter).lean(); if (existing) return replay(existing);
    const session = await RenewalOperation.db.startSession();
    try {
      return await session.withTransaction(async () => {
        const committed = await RenewalOperation.findOne(filter).session(session).lean(); if (committed) return replay(committed);
        const subscription = await subscriptionService.renewForPurchase(auth, selected, id, data, session);
        const initial = data.payment;
        const payment = initial?.amountPaise > 0 ? await paymentService.createForPurchase(auth, selected, {
          memberId: subscription.memberId, subscriptionId: subscription.id, amountPaise: initial.amountPaise,
          paymentMethod: initial.method, paidAt: initial.paidAt, transactionReference: initial.reference }, session) : null;
        const price = subscription.pricePaiseSnapshot; const collected = payment?.amountPaise ?? 0;
        const result = JSON.parse(JSON.stringify({ subscription, payment,
          billing: { planPricePaise: price, amountReceivedPaise: collected,
            outstandingBalancePaise: Number(BigInt(price) - BigInt(collected)) } }));
        await RenewalOperation.create([{ ...filter, subscriptionId: id, requestDigest, resultJson: JSON.stringify(result) }], { session });
        return result;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
      if (error.code === 11000 && error.keyPattern?.keyDigest) {
        const committed = await RenewalOperation.findOne(filter).lean(); if (committed) return replay(committed);
      }
      throw error;
    } finally { await session.endSession(); }
  } };
}
module.exports = { createRenewalService };
