const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');

const accountStatuses = ['active', 'inactive', 'suspended'];
const createUserAccount = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  displayName: z.string().trim().min(1).max(120).optional(),
  status: z.enum(accountStatuses).default('inactive'),
});
const userParams = z.strictObject({ userId: objectId });

function normalizeEmail(email) {
  // Do not remove dots or plus-tags: provider-specific rules would merge identities.
  return email.trim().toLowerCase();
}

module.exports = { accountStatuses, createUserAccount, userParams, normalizeEmail };
