const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const statuses = ['active', 'inactive'];
const createAssignment = z.strictObject({
  trainerId: objectId, memberId: objectId,
  assignedAt: z.iso.datetime({ offset: true }).refine((value) =>
    Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now(), 'Assignment date cannot be in the future').optional(),
});
const updateAssignment = z.strictObject({ status: z.literal('inactive') });
const assignmentParams = z.strictObject({ gymId: objectId, assignmentId: objectId });
const assignmentListQuery = listQuery.extend({
  status: z.enum(statuses).optional(), trainerId: objectId.optional(), memberId: objectId.optional(),
});
const assignmentListInput = assignmentListQuery.extend({
  page: z.number().int().min(1).max(10000), limit: z.number().int().min(1).max(100),
});
module.exports = { statuses, createAssignment, updateAssignment, assignmentParams, assignmentListQuery, assignmentListInput };
