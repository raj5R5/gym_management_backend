const { z } = require('zod');

const name = z.string().trim().min(2).max(120);
const status = z.enum(['active', 'inactive']);
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
const contact = z.strictObject({
  email: z.email().max(254).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/).refine((value) =>
    value.replace(/\D/g, '').length >= 7, 'Invalid phone number').optional(),
}).refine((value) => Object.keys(value).length > 0, 'Contact cannot be empty');
const settings = z.strictObject({
  timezone: z.string().max(100).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
    catch { return false; }
  }, 'Invalid timezone').optional(),
}).refine((value) => Object.keys(value).length > 0, 'Settings cannot be empty');
const createGym = z.strictObject({
  name, status: status.default('active'), contact: contact.optional(), settings: settings.optional(),
});
const updateGym = createGym.omit({ status: true }).extend({ status }).partial()
  .refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');
const gymParams = z.strictObject({ gymId: objectId });
const listQuery = z.strictObject({
  page: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(10000)).prefault('1'),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).prefault('20'),
});

module.exports = { name, status, objectId, contact, createGym, updateGym, gymParams, listQuery };
