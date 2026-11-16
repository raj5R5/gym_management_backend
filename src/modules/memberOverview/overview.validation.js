const { z } = require('zod');
const { listQuery } = require('../gyms/gym.validation');

const filters = ['all', 'active', 'expiring', 'dues', 'expired', 'none', 'inactive'];
const overviewQuery = listQuery.extend({
  filter: z.enum(filters).default('all'),
  search: z.string().trim().min(1).max(100).optional(),
});
const birthdayQuery = z.strictObject({
  days: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(30)).prefault('7'),
});
module.exports = { filters, overviewQuery, birthdayQuery };
