function createDashboardController(service) {
  return { async get(req, res) {
    const data = await service.get(req.auth, req.authorization, req.validated.query);
    return res.json({ success: true, data, meta: { requestId: req.id } });
  } };
}
module.exports = { createDashboardController };
