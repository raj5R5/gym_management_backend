const { z } = require('zod');
const { listQuery, gymParams } = require('../gyms/gym.validation');
const listInput = listQuery.extend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
const empty = z.strictObject({});
module.exports = { listQuery, listInput, gymParams, empty };
