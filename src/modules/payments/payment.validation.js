const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const statuses = ['pending', 'succeeded', 'failed', 'cancelled'];
const methods = ['cash', 'upi', 'bank_transfer', 'card', 'other'];
const timestamp = z.iso.datetime({ offset: true }).refine((value) =>
  Date.parse(value) >= Date.parse('1970-01-01T00:00:00Z') && Date.parse(value) <= Date.now(), 'Invalid payment timestamp');
const transactionReference = z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/);
const createPayment = z.strictObject({ memberId: objectId, subscriptionId: objectId,
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE), paymentMethod: z.enum(methods), paidAt: timestamp,
  transactionReference: transactionReference.optional(), notes: z.string().trim().min(1).max(2000).optional() });
const paymentParams = z.strictObject({ gymId: objectId, paymentId: objectId });
const paymentListQuery = listQuery.extend({ memberId: objectId.optional(), subscriptionId: objectId.optional(),
  status: z.enum(statuses).optional(), paymentMethod: z.enum(methods).optional(),
  paidFrom: timestamp.optional(), paidTo: timestamp.optional() }).refine((value) =>
  !value.paidFrom || !value.paidTo || Date.parse(value.paidFrom) <= Date.parse(value.paidTo), 'Invalid payment range');
const paymentListInput = paymentListQuery.safeExtend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { statuses, methods, createPayment, paymentParams, paymentListQuery, paymentListInput };
