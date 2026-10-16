function createOwnerRegistrationController(service) {
  return {
    async register(req, res) {
      const data = await service.register(req.validated.body);
      req.log?.info({ event: 'owner.registration', outcome: 'success', requestId: req.id }, 'Owner registration completed');
      return res.status(201).json({ success: true, data, meta: { requestId: req.id } });
    },
  };
}
module.exports = { createOwnerRegistrationController };
