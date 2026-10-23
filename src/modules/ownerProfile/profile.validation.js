const { z } = require('zod');
const { name, contact } = require('../gyms/gym.validation');
const phone = contact.shape.phone.unwrap();
const optionalPhone = z.union([phone, z.literal('')]);
const optionalEmail = z.union([z.email().max(254), z.literal('')]);
const updateProfile = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
  phone: optionalPhone,
  gymName: name,
  gymContactPhone: optionalPhone,
  gymContactEmail: optionalEmail,
  currentPassword: z.string().min(1).max(128).optional(),
});
module.exports = { updateProfile };
