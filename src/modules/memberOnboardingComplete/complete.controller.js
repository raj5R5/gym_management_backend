function createCompleteOnboardingController(service) {
  return { async complete(req, res) {
    const data = await service.complete(req.auth, req.authorization, req.validated.body, req.validated.headers['idempotency-key']);
    return res.status(201).json({ success: true, data, meta: { requestId: req.id } });
  } };
}
module.exports = { createCompleteOnboardingController };
