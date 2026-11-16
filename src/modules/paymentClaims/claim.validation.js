const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

const createClaim = z.strictObject({
  amountPaise: z.number().int().min(1).max(MAX_PRICE_PAISE),
  reference: z.string().trim().regex(/^\d{12}$/, 'Enter the 12-digit UPI transaction ID'),
});
const claimParams = z.strictObject({ gymId: objectId, claimId: objectId });
const claimListQuery = z.strictObject({ status: z.enum(['pending', 'confirmed', 'rejected']).default('pending') });
const rejectClaim = z.strictObject({ reason: z.string().trim().min(1).max(200) });
module.exports = { createClaim, claimParams, claimListQuery, rejectClaim };
