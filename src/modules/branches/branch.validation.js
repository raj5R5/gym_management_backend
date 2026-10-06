const { z } = require('zod');
const { name, status, objectId, contact } = require('../gyms/gym.validation');

const text = (max) => z.string().trim().min(1).max(max);
const address = z.strictObject({
  line1: text(200), line2: text(200).optional(), city: text(100),
  state: text(100).optional(), postalCode: text(20).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
});
const createBranch = z.strictObject({
  name, address, contact: contact.optional(), status: status.default('active'),
});
const updateBranch = createBranch.omit({ status: true }).extend({ status }).partial()
  .refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');
const branchParams = z.strictObject({ gymId: objectId, branchId: objectId });

module.exports = { createBranch, updateBranch, branchParams };
