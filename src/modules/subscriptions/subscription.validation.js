const { z } = require('zod');
const { methods, timestamp, transactionReference } = require('../payments/payment.fields');
const { createPlan } = require('../membershipPlans/plan.validation');
const { objectId, listQuery } = require('../gyms/gym.validation');
const statuses = ['active', 'expired', 'cancelled'];
const today = () => new Date().toISOString().slice(0, 10);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return value >= '0001-01-01' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const createSubscription = z.strictObject({ memberId: objectId, membershipPlanId: objectId,
  startDate: calendarDate,
  notes: z.string().trim().min(1).max(2000).optional() });
const renewalTerms = z.strictObject({ planName: createPlan.shape.name, durationDays: createPlan.shape.durationDays,
  pricePaise: createPlan.shape.price, startDate: calendarDate, endDate: calendarDate });
const renewSubscription = z.strictObject({ startDate: calendarDate.optional(), expectedTerms: renewalTerms.optional(),
  notes: z.string().trim().min(1).max(2000).optional() }).default({});
const renewalPreviewQuery = z.strictObject({ planId: objectId.optional(), startDate: calendarDate.optional() });
const initialPayment = z.strictObject({ amountPaise: createPlan.shape.price,
  method: z.enum(methods), paidAt: timestamp,
  reference: transactionReference.optional() }).refine((value) => value.amountPaise === 0 ||
    !['upi', 'bank_transfer', 'card'].includes(value.method) || Boolean(value.reference));
const renewalPurchase = z.strictObject({ planId: objectId, expectedTerms: renewalTerms,
  startDate: calendarDate.optional(), payment: initialPayment.optional() });
const renewalBody = z.union([renewSubscription, renewalPurchase]);
const cancelSubscription = z.strictObject({ cancellationReason: z.string().trim().min(1).max(500).optional() }).default({});
const subscriptionParams = z.strictObject({ gymId: objectId, subscriptionId: objectId });
const subscriptionListQuery = listQuery.extend({ status: z.enum(statuses).optional(), memberId: objectId.optional(), membershipPlanId: objectId.optional() });
const subscriptionListInput = subscriptionListQuery.extend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { statuses, today, calendarDate, createSubscription, renewSubscription, cancelSubscription,
  subscriptionParams, subscriptionListQuery, subscriptionListInput, renewalPreviewQuery, renewalPurchase, renewalBody };
