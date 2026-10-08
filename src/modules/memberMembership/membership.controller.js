function createMemberMembershipController(service) {
  return { async create(req, res) {
    const data = await service.create(req.auth, req.authorization, req.validated.body);
    return res.status(201).json({ success: true, data, meta: { requestId: req.id } });
  } };
}
module.exports = { createMemberMembershipController };
