const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');

const roles = ['admin', 'trainer', 'member'];
const accessStatuses = ['active', 'inactive', 'suspended'];
const createGymAccess = z.strictObject({
  userId: objectId,
  // An explicit local bootstrap provisioning instruction, never an authorization claim.
  role: z.enum(roles),
  status: z.enum(accessStatuses).default('inactive'),
});
const accessParams = z.strictObject({ gymId: objectId, accessId: objectId });

module.exports = { roles, accessStatuses, createGymAccess, accessParams };
