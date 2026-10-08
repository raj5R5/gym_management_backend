function createMemberSelfController(service) {
  return (kind) => async (req, res) => {
    const result = await service.read(req.auth, req.authorization, kind, req.validated.query);
    return res.json({ success: true, data: result.data, meta: { requestId: req.id,
      ...(result.pagination ? { pagination: result.pagination } : {}) } });
  };
}
module.exports = { createMemberSelfController };
