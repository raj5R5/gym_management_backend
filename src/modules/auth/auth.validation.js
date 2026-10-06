const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const commonPasswords = new Set([
  'correcthorsebatterystaple', 'thisisapassword', 'iloveyou', 'changeme',
  'letmein', 'welcome', 'admin', 'gymmanagement',
]);
function acceptablePassword(value) {
  const comparison = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!value.trim() || /^(.{1,8})\1+$/u.test(value)) return false;
  if (commonPasswords.has(comparison)) return false;
  return !/^(?:p[a@]ssw[o0]rd|qwerty|letmein|welcome|changeme|administrator|1234567890|abcdefghijklmnopqrstuvwxyz)[0-9!@#$%^&*._-]*$/i.test(value.trim());
}
// Preserve the original passphrase; normalization is only for blocklist comparison.
const password = z.string().min(15).max(128).refine(acceptablePassword, 'Choose a less predictable password');
const login = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(1).max(128), client: z.enum(['web', 'mobile']).optional(),
});
const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const refresh = z.strictObject({ refreshToken: credential.optional() }).default({});
const provision = z.strictObject({ password });
const userParams = z.strictObject({ userId: objectId });
module.exports = { login, refresh, provision, userParams };
