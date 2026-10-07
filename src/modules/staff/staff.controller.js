function createStaffController(service) {
  const audit = (req) => ({ logger: req.log, requestId: req.id });
  const send = (req, res, data, status = 200, meta = {}) => res.status(status).json({ success: true, data, meta: { requestId: req.id, ...meta } });
  return {
    async create(req, res) { return send(req, res, await service.create(req.auth, req.authorization, req.validated.body, audit(req)), 201); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.userId)); },
    async list(req, res) { const result = await service.list(req.auth, req.authorization, req.validated.query); return send(req, res, result.data, 200, { pagination: result.pagination }); },
    async update(req, res) { return send(req, res, await service.update(req.auth, req.authorization, req.validated.params.userId, req.validated.body, audit(req))); },
  };
}
module.exports = { createStaffController };
