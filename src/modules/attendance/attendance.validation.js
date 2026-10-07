const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const statuses = ['open', 'completed', 'cancelled'];
const timestamp = z.iso.datetime({ offset: true }).refine((value) => Date.parse(value) >= 0);
const checkIn = z.strictObject({ memberId: objectId, branchId: objectId });
const checkOut = z.strictObject({}).default({});
const attendanceParams = z.strictObject({ gymId: objectId, attendanceId: objectId });
const attendanceListQuery = listQuery.extend({ memberId: objectId.optional(), branchId: objectId.optional(),
  subscriptionId: objectId.optional(), status: z.enum(statuses).optional(),
  checkInFrom: timestamp.optional(), checkInTo: timestamp.optional() }).refine((value) =>
  !value.checkInFrom || !value.checkInTo || Date.parse(value.checkInFrom) <= Date.parse(value.checkInTo));
const attendanceListInput = attendanceListQuery.safeExtend({ page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100) });
module.exports = { statuses, checkIn, checkOut, attendanceParams, attendanceListQuery, attendanceListInput };
