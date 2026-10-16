function createSubscriptionController(service, renewalService) {
  const send = (req, res, data, status = 200, meta = {}) => res.status(status).json({ success: true, data,
    meta: { requestId: req.id, ...meta } });
  return {
    async create(req, res) { return send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.subscriptionId)); },
    async list(req, res) {
      const result = await service.list(req.auth, req.authorization, req.validated.query);
      return send(req, res, result.data, 200, { pagination: result.pagination });
    },
    async renewalPreview(req, res) {
      return send(req, res, await service.renewalPreview(req.auth, req.authorization, req.validated.params.subscriptionId, req.validated.query));
    },
    async renew(req, res) {
      const data = req.validated.body;
      const result = data.planId
        ? await renewalService.complete(req.auth, req.authorization, req.validated.params.subscriptionId, data, req.headers['idempotency-key'])
        : await service.renew(req.auth, req.authorization, req.validated.params.subscriptionId, data);
      return send(req, res, result, 201);
    },
    async cancel(req, res) {
      return send(req, res, await service.cancel(req.auth, req.authorization, req.validated.params.subscriptionId, req.validated.body));
    },
  };
}
module.exports = { createSubscriptionController };
