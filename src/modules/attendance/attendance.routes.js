const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./attendance.validation');
const { createAttendanceController } = require('./attendance.controller');
function createAttendanceRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createAttendanceController(service);
  router.use(authenticate(authService)); router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use(authorization.requireRoles('admin', 'trainer'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const readGuard = async (req, _res, next) => {
    try { await service.authorizeRead(req.auth, req.authorization, req.validated.params?.attendanceId); next(); }
    catch (error) { next(error); }
  };
  router.post('/check-in', validate({ body: schemas.checkIn }), controller.checkIn);
  router.post('/:attendanceId/check-out', validate({ params: schemas.attendanceParams, body: schemas.checkOut }), readGuard, controller.checkOut);
  router.get('/', validate({ query: schemas.attendanceListQuery }), readGuard, controller.list);
  router.get('/:attendanceId', validate({ params: schemas.attendanceParams }), readGuard, controller.get);
  return router;
}
module.exports = { createAttendanceRouter };
