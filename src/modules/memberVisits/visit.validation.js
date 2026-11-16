const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { methods } = require('./visit.model');

const checkIn = z.strictObject({
  memberId: objectId,
  method: z.enum(methods).default('manual'),
  // Required to admit a member without an active membership.
  override: z.boolean().default(false),
});
const memberVisitParams = z.strictObject({ gymId: objectId, memberId: objectId });
const visitListQuery = listQuery;
module.exports = { checkIn, memberVisitParams, visitListQuery };
