const { z } = require('zod');
const { objectId, gymParams } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const dashboardQuery = z.strictObject({ branchId: objectId.optional(), from: calendarDate.optional(), to: calendarDate.optional(), preset: z.enum(['last7Days', 'thisMonth']).optional() })
  .refine(({ preset, from, to }) => !preset || (!from && !to))
  .refine(({ from, to }) => !from || !to || (from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 < 366))
  .refine(({ from, to }) => (to ?? from ?? '0001-01-01') < '9999-12-31');
module.exports = { dashboardParams: gymParams, dashboardQuery };
