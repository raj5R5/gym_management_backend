function createGymAccessController(service) {
  const send = (req, res, data, status = 200, extraMeta = {}) => res.status(status).json({
    success: true, data, meta: { requestId: req.id, ...extraMeta },
  });
  return {
    async create(req, res) {
      return send(req, res, await service.create(req.validated.params.gymId, req.validated.body), 201);
    },
    async get(req, res) {
      const { gymId, accessId } = req.validated.params;
      return send(req, res, await service.get(gymId, accessId));
    },
    async list(req, res) {
      const result = await service.list(req.validated.params.gymId, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
  };
}

module.exports = { createGymAccessController };
