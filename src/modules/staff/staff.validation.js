const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { createUserAccount } = require('../userAccounts/userAccount.validation');
const { provision } = require('../auth/auth.validation');
const role = z.enum(['admin', 'trainer']);
const status = z.enum(['active', 'inactive', 'suspended']);
const displayName = z.string().trim().min(1).max(120);
// trainerId links a trainer login to the trainer's profile, so the trainer app can find their clients.
const createStaff = z.strictObject({ email: createUserAccount.shape.email, displayName, role, password: provision.shape.password,
  trainerId: objectId.optional() }).refine((value) => !value.trainerId || value.role === 'trainer', 'trainerId needs the trainer role');
const updateStaff = z.strictObject({ displayName: displayName.optional(), role: role.optional(), status: status.optional() })
  .refine((value) => Object.keys(value).length > 0);
const staffParams = z.strictObject({ gymId: objectId, userId: objectId });
const staffListQuery = listQuery.extend({ role: role.optional(), status: status.optional() });
const staffListInput = staffListQuery.extend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { createStaff, updateStaff, staffParams, staffListQuery, staffListInput };
