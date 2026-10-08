function createMembershipManagementController(service) {
  const send = (req, res, data, meta = {}) => res.json({ success: true, data, meta: { requestId: req.id, ...meta } });
  return {
    async list(req, res) { const result = await service.list(req.auth, req.authorization, req.params.memberId, req.query); return send(req, res, result.data, { pagination: result.pagination }); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.params.memberId, req.params.subscriptionId)); },
    async cancel(req, res) { return send(req, res, await service.cancel(req.auth, req.authorization, req.params.memberId, req.params.subscriptionId, req.validated.body)); },
  };
}
module.exports = { createMembershipManagementController };
