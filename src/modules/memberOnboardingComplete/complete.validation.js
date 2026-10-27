const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { onboardMember } = require('../members/member.validation');
const { createSubscription } = require('../subscriptions/subscription.validation');
const { createPayment } = require('../payments/payment.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const payment = z.strictObject({
  method: createPayment.shape.paymentMethod,
  amountPaise: z.number().int().min(0).max(MAX_PRICE_PAISE),
  paidAt: createPayment.shape.paidAt,
  reference: createPayment.shape.transactionReference.optional(),
}).refine((value) => value.amountPaise === 0 || !['upi', 'bank_transfer', 'card'].includes(value.method)
  || Boolean(value.reference), 'A reference is required for this payment method');
const completeOnboarding = z.strictObject({
  // Legacy frozen requests must retain their original digest and receipt.
  member: onboardMember.extend({ branchId: objectId.optional() }),
  membership: z.strictObject({
    planId: objectId,
    startDate: createSubscription.shape.startDate.optional(),
    payment: payment.optional(),
  }).optional(),
});
// HTTP headers include other legitimate values; only this header is consumed.
const completeHeaders = z.object({ 'idempotency-key': idempotencyKey });
module.exports = { completeOnboarding, completeHeaders, idempotencyKey };
