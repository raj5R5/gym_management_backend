const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { categories, methods } = require('./expense.model');

const createExpense = z.strictObject({
  category: z.enum(categories),
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE),
  spentOn: calendarDate,
  paymentMethod: z.enum(methods).default('cash'),
  note: z.string().trim().min(1).max(500).optional(),
});
const expenseParams = z.strictObject({ gymId: objectId, expenseId: objectId });
const expenseListQuery = listQuery.extend({
  from: calendarDate.optional(), to: calendarDate.optional(), category: z.enum(categories).optional(),
}).refine(({ from, to }) => !from || !to || from <= to, 'from must not be after to');
module.exports = { createExpense, expenseParams, expenseListQuery };
