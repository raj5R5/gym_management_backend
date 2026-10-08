const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { calendarDate, statuses, cancelSubscription } = require('../subscriptions/subscription.validation');
const memberParams = z.strictObject({ gymId: objectId, memberId: objectId });
const itemParams = memberParams.extend({ subscriptionId: objectId });
const historyQuery = listQuery.extend({ status: z.enum(statuses).optional(), from: calendarDate.optional(), to: calendarDate.optional() })
  .refine(({ from, to }) => !from || !to || from <= to);
module.exports = { memberParams, itemParams, historyQuery, cancelSubscription, emptyQuery: z.strictObject({}) };
