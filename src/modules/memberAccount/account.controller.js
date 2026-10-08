function createMemberAccountController(service) {
  const audit = (req) => ({ logger: req.log, requestId: req.id });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  return {
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.memberId)); },
    async provision(req, res) {
      const result = await service.provision(req.auth, req.authorization, req.validated.params.memberId, req.validated.body, audit(req));
      return send(req, res, { ...result.data, ...(result.activationToken ? { activationToken: result.activationToken,
        activationExpiresAt: result.activationExpiresAt } : {}) }, 201);
    },
    async revoke(req, res) { return send(req, res, await service.revoke(req.auth, req.authorization, req.validated.params.memberId, audit(req))); },
    async activate(req, res) { return send(req, res, await service.activate(req.validated.body, audit(req))); },
  };
}
module.exports = { createMemberAccountController };
