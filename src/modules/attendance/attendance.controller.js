function createAttendanceController(service) {
  const send = (req, res, data, status = 200, meta = {}) => res.status(status).json({ success: true, data, meta: { requestId: req.id, ...meta } });
  return {
    async checkIn(req, res) { return send(req, res, await service.checkIn(req.auth, req.authorization, req.validated.body), 201); },
    async checkOut(req, res) { return send(req, res, await service.checkOut(req.auth, req.authorization, req.validated.params.attendanceId, req.validated.body)); },
    async get(req, res) { return send(req, res, await service.get(req.auth, req.authorization, req.validated.params.attendanceId)); },
    async list(req, res) { const result = await service.list(req.auth, req.authorization, req.validated.query); return send(req, res, result.data, 200, { pagination: result.pagination }); },
  };
}
module.exports = { createAttendanceController };
