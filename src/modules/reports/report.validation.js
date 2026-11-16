const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');

// URL names for the report builders.
const kindNames = { 'profit-loss': 'profitLoss', collections: 'collections', members: 'members', attendance: 'attendance',
  dues: 'dues', leads: 'leads', trainers: 'trainers', plans: 'plans' };
const reportParams = z.strictObject({ gymId: objectId, kind: z.enum(Object.keys(kindNames)) });
const reportQuery = z.strictObject({
  preset: z.enum(['thisMonth', 'lastMonth', 'last3Months', 'last12Months', 'thisYear']).optional(),
  from: calendarDate.optional(), to: calendarDate.optional(),
  scope: z.enum(['branch', 'all']).default('branch'),
}).refine(({ from, to }) => Boolean(from) === Boolean(to) && (!from || from <= to), 'Give both from and to, in order');
module.exports = { kindNames, reportParams, reportQuery };
