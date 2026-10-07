const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const text = (max) => z.string().trim().min(1).max(max);
const statuses = ['active', 'inactive', 'suspended'];
const genders = ['female', 'male', 'non_binary', 'other', 'prefer_not_to_say'];
const phone = text(25).regex(/^\+?[0-9 ()-]+$/).refine((value) => {
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
});
const memberCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const dateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && value <= new Date().toISOString().slice(0, 10);
});
const address = z.strictObject({ line1: text(200), line2: text(200).optional(), city: text(100),
  state: text(100).optional(), postalCode: text(20).optional(), countryCode: z.string().regex(/^[A-Z]{2}$/) });
const emergencyContact = z.strictObject({ name: text(120), phone, relationship: text(80).optional() });
const mutable = {
  firstName: text(80), lastName: text(80), phone,
  branchId: objectId.nullable().optional(), dateOfBirth: dateOfBirth.nullable().optional(),
  gender: z.enum(genders).nullable().optional(), address: address.nullable().optional(),
  emergencyContact: emergencyContact.nullable().optional(), status: z.enum(statuses),
};
const createMember = z.strictObject({ ...mutable, memberCode, status: z.enum(statuses).default('active') });
const updateMember = z.strictObject(mutable).partial()
  .refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');
const memberParams = z.strictObject({ gymId: objectId, memberId: objectId });
const memberListQuery = listQuery.extend({ status: z.enum(statuses).optional(), search: text(100).optional() });
module.exports = { createMember, updateMember, memberParams, memberListQuery, statuses, genders };
