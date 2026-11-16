const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

// Owner rules (Phase 3b): plans of 90+ days, at most 30 frozen days per
// membership in total, freezes start today or later.
const FREEZE_RULES = Object.freeze({ minPlanDays: 90, maxTotalDays: 30 });
const reason = z.string().trim().min(1).max(300);
const adjustmentParams = z.strictObject({ gymId: objectId, subscriptionId: objectId });
const freezeParams = adjustmentParams.extend({ freezeId: objectId });
const createFreeze = z.strictObject({
  startDate: calendarDate, days: z.number().int().min(1).max(FREEZE_RULES.maxTotalDays), reason: reason.optional(),
});
// Exactly one of amountPaise or percent. A percent is converted on the server.
const createDiscount = z.strictObject({
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE).optional(),
  percent: z.number().min(0.01).max(100).multipleOf(0.01).optional(),
  reason: reason.optional(),
}).refine((value) => (value.amountPaise === undefined) !== (value.percent === undefined),
  'Give an amount or a percent');
module.exports = { FREEZE_RULES, adjustmentParams, freezeParams, createFreeze, createDiscount };
