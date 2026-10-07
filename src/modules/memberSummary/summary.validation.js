const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const summaryParams = z.strictObject({ gymId: objectId, memberId: objectId });
const summaryQuery = listQuery;
const summaryInput = z.strictObject({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { summaryParams, summaryQuery, summaryInput };
