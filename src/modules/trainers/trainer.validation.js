const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const text = (max) => z.string().trim().min(1).max(max);
const statuses = ['active', 'inactive', 'suspended'];
const genders = ['female', 'male', 'non_binary', 'other', 'prefer_not_to_say'];
const phone = text(25).regex(/^\+?[0-9 ()-]+$/).refine((value) => {
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
});
const trainerCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/);
const dateOfBirth = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && value <= new Date().toISOString().slice(0, 10);
});
const address = z.strictObject({ line1: text(200), line2: text(200).optional(), city: text(100),
  state: text(100).optional(), postalCode: text(20).optional(), countryCode: z.string().regex(/^[A-Z]{2}$/) });
const specializations = z.array(text(80)).max(10).refine((values) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length, 'Specializations must be distinct');
const mutable = {
  firstName: text(80), lastName: text(80), phone,
  dateOfBirth: dateOfBirth.nullable().optional(),
  gender: z.enum(genders).nullable().optional(), address: address.nullable().optional(),
  specializations: specializations.nullable().optional(), status: z.enum(statuses),
};
const createTrainer = z.strictObject({ ...mutable, trainerCode, status: z.enum(statuses).default('active') });
const updateTrainer = z.strictObject(mutable).partial()
  .refine((value) => Object.keys(value).length > 0, 'Update cannot be empty');
const trainerParams = z.strictObject({ gymId: objectId, trainerId: objectId });
const trainerListQuery = listQuery.extend({ status: z.enum(statuses).optional(), search: text(100).optional() });
// The HTTP boundary transforms pagination; service callers supply that validated shape.
const trainerListInput = trainerListQuery.extend({
  page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100),
});
module.exports = { createTrainer, updateTrainer, trainerParams, trainerListQuery, trainerListInput, statuses, genders };
