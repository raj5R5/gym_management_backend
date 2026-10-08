const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { createSubscription } = require('../subscriptions/subscription.validation');
const { createPayment } = require('../payments/payment.validation');
const payment = z.discriminatedUnion('enabled', [z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), method: createPayment.shape.paymentMethod,
    amountPaise: createPayment.shape.amountPaise, paidAt: createPayment.shape.paidAt,
    reference: createPayment.shape.transactionReference.optional() })]);
const purchaseMembership = z.strictObject({ memberId: objectId, planId: objectId,
  startDate: createSubscription.shape.startDate.optional(), payment: payment.optional() });
module.exports = { purchaseMembership };
