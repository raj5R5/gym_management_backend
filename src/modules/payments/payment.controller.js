function createPaymentController(service) {
  const send = (req, res, data, status = 200, meta = {}) => res.status(status).json({ success: true, data,
    meta: { requestId: req.id, ...meta } });
  return {
    async create(req, res) { return send(req, res, await service.create(req.auth, req.authorization, req.validated.body, req.validated.headers['idempotency-key']), 201); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.paymentId)); },
    async list(req, res) {
      const result = await service.list(req.auth, req.authorization, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination, ...(result.summary ? { summary: result.summary, period: result.period } : {}) });
    },
  };
}
module.exports = { createPaymentController };
