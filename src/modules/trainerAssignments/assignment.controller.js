function createAssignmentController(service) {
  const send = (req, res, data, status = 200, meta = {}) => res.status(status).json({ success: true, data,
    meta: { requestId: req.id, ...meta } });
  return {
    async create(req, res) { return send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.assignmentId)); },
    async list(req, res) {
      const result = await service.list(req.auth, req.authorization, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
    async update(req, res) {
      return send(req, res, await service.update(req.auth, req.authorization, req.validated.params.assignmentId, req.validated.body));
    },
    async deactivate(req, res) {
      return send(req, res, await service.update(req.auth, req.authorization, req.validated.params.assignmentId, { status: 'inactive' }));
    },
    async trainerMembers(req, res) {
      const result = await service.trainerMembers(req.auth, req.authorization, req.validated.params.trainerId, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
    async memberTrainers(req, res) {
      const result = await service.memberTrainers(req.auth, req.authorization, req.validated.params.memberId, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
  };
}
module.exports = { createAssignmentController };
