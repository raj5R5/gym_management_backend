const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { methods, transactionReference } = require('../payments/payment.fields');

const payment = z.strictObject({
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE),
  method: z.enum(methods).default('cash'),
  reference: transactionReference.optional(),
}).refine((value) => !['upi', 'bank_transfer', 'card'].includes(value.method) || Boolean(value.reference),
  'A reference is required for this payment method');
const createPackage = z.strictObject({
  memberId: objectId, trainerId: objectId,
  name: z.string().trim().min(1).max(120).default('Personal training'),
  sessions: z.number().int().min(1).max(200),
  pricePaise: z.number().int().min(0).max(MAX_PRICE_PAISE),
  startDate: calendarDate.optional(),
  validDays: z.number().int().min(1).max(730).optional(),
  payment: payment.optional(),
});
const logSession = z.strictObject({ sessionDate: calendarDate.optional(), note: z.string().trim().min(1).max(300).optional() });
const setRate = z.strictObject({ percent: z.number().min(0).max(100).multipleOf(0.01) });
const packageParams = z.strictObject({ gymId: objectId, packageId: objectId });
const trainerParams = z.strictObject({ gymId: objectId, trainerId: objectId });
const packageListQuery = listQuery.extend({
  memberId: objectId.optional(), trainerId: objectId.optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
});
const periodQuery = z.strictObject({ preset: z.enum(['today', 'last7Days', 'thisMonth']).optional(),
  from: calendarDate.optional(), to: calendarDate.optional() })
  .refine(({ from, to }) => !from || !to || from <= to, 'from must not be after to');
module.exports = { createPackage, payment, logSession, setRate, packageParams, trainerParams, packageListQuery, periodQuery };
