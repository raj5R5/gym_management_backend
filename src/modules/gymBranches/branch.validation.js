const { z } = require('zod');
const { name, objectId } = require('../gyms/gym.validation');

// A branch is its own gym (owner choice): new Gym + admin GymAccess for the owner.
const createBranch = z.strictObject({
  name,
  // Optionally start from an existing gym the owner administers.
  fromGymId: objectId.optional(),
  copyPlans: z.boolean().default(true),
  copySettings: z.boolean().default(true),
}).refine((value) => value.fromGymId || (!value.copyPlans && !value.copySettings),
  'Copying needs a source gym');
const summaryQuery = z.strictObject({ preset: z.enum(['today', 'last7Days', 'thisMonth']).default('thisMonth') });
module.exports = { createBranch, summaryQuery, MAX_BRANCHES: 20 };
