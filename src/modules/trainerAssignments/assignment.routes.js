const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./assignment.validation');
const { createAssignmentController } = require('./assignment.controller');
function createAssignmentRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  const controller = createAssignmentController(service);
  router.use(authenticate(authService));
  router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const readGuard = async (req, _res, next) => {
    try {
      await service.authorizeRead(req.auth, req.authorization, req.validated.params?.assignmentId);
      next();
    } catch (error) { next(error); }
  };
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createAssignment }), controller.create);
  router.get('/', authorization.requireRoles('admin', 'trainer'), validate({ query: schemas.assignmentListQuery }), readGuard, controller.list);
  router.get('/:assignmentId', authorization.requireRoles('admin', 'trainer'),
    validate({ params: schemas.assignmentParams }), readGuard, controller.get);
  router.patch('/:assignmentId', authorization.requireRoles('admin'),
    validate({ params: schemas.assignmentParams, body: schemas.updateAssignment }), controller.update);
  return router;
}
module.exports = { createAssignmentRouter };
