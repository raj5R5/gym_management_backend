const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const statuses = ['active', 'inactive'];
const MAX_DURATION_DAYS = 3650;
const MAX_PRICE_PAISE = 1_000_000_000;
function normalizePlanName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : value;
}
const name = z.string().transform(normalizePlanName).pipe(z.string().min(1).max(120));
const description = z.string().trim().min(1).max(2000);
const fields = { name, durationDays: z.number().int().min(1).max(MAX_DURATION_DAYS),
  price: z.number().int().min(0).max(MAX_PRICE_PAISE), status: z.enum(statuses),
  description: description.nullable().optional() };
const createPlan = z.strictObject({ ...fields, status: z.enum(statuses).default('active') });
const updatePlan = z.strictObject(fields).partial().refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');
const planParams = z.strictObject({ gymId: objectId, planId: objectId });
const planListQuery = listQuery.extend({ status: z.enum(statuses).optional(),
  search: z.string().trim().min(1).max(100).optional() });
const planListInput = planListQuery.extend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { statuses, MAX_DURATION_DAYS, MAX_PRICE_PAISE, normalizePlanName,
  createPlan, updatePlan, planParams, planListQuery, planListInput };
