function createGymController(service) {
  const send = (req, res, data, status = 200, extraMeta = {}) => res.status(status).json({
    success: true, data, meta: { requestId: req.id, ...extraMeta },
  });
  return {
    async create(req, res) { return send(req, res, await service.create(req.validated.body), 201); },
    async get(req, res) { return send(req, res, await service.get(req.validated.params.gymId)); },
    async list(req, res) {
      const result = await service.list(req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
    async update(req, res) {
      return send(req, res, await service.update(req.validated.params.gymId, req.validated.body));
    },
  };
}

module.exports = { createGymController };
