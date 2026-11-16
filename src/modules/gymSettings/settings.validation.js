const { z } = require('zod');

const text = (max) => z.string().trim().min(1).max(max);
const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid timezone');
// Indian GSTIN: 2-digit state code, PAN, entity number, 'Z', checksum character.
const gstin = z.string().trim().toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');
const address = z.strictObject({
  line1: text(200), line2: text(200).optional(), city: text(100), state: text(100).optional(),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9 -]{3,12}$/).optional(),
});
const upiId = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/, 'Invalid UPI ID');
const upiPayeeName = z.string().trim().min(1).max(50).regex(/^[\p{L}\p{N} .&'-]+$/u);
// null clears an optional value; omitted fields stay unchanged. The timezone cannot be cleared.
const updateSettings = z.strictObject({
  timezone: timezone.optional(), gstin: gstin.nullable().optional(), address: address.nullable().optional(),
  upiId: upiId.nullable().optional(), upiPayeeName: upiPayeeName.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');

module.exports = { updateSettings };
