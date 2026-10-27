const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { dashboardQuery } = require('../gymDashboard/dashboard.validation');
const statuses = ['pending', 'succeeded', 'failed', 'cancelled'];
const { methods, timestamp, transactionReference } = require('./payment.fields');
const createPayment = z.strictObject({ memberId: objectId, subscriptionId: objectId,
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE), paymentMethod: z.enum(methods), paidAt: timestamp,
  transactionReference: transactionReference.optional(), notes: z.string().trim().min(1).max(2000).optional() });
const paymentParams = z.strictObject({ gymId: objectId, paymentId: objectId });
const paymentListQuery = listQuery.extend({ memberId: objectId.optional(), subscriptionId: objectId.optional(),
  status: z.enum(statuses).optional(), paymentMethod: z.enum(methods).optional(),
  paidFrom: timestamp.optional(), paidTo: timestamp.optional(),
  from: dashboardQuery.shape.from, to: dashboardQuery.shape.to,
  includeMember: z.enum(['true', 'false']).optional(),
}).refine(({ from, to, paidFrom, paidTo }) => (!from && !to) || ((!paidFrom && !paidTo) && dashboardQuery.safeParse({ from, to }).success))
  .refine((value) =>
  !value.paidFrom || !value.paidTo || Date.parse(value.paidFrom) <= Date.parse(value.paidTo), 'Invalid payment range');
const paymentListInput = paymentListQuery.safeExtend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
const paymentHeaders = z.object({ 'idempotency-key': z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional() });
module.exports = { paymentHeaders, statuses, methods, createPayment, paymentParams, paymentListQuery, paymentListInput };
