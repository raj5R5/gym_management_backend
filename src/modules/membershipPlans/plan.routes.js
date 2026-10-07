const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./plan.validation');
const { createPlanController } = require('./plan.controller');
function createPlanRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  const controller = createPlanController(service);
  router.use(authenticate(authService));
  router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createPlan }), controller.create);
  router.get('/', authorization.requireRoles('admin', 'trainer'), validate({ query: schemas.planListQuery }), controller.list);
  router.get('/:planId', authorization.requireRoles('admin', 'trainer'), validate({ params: schemas.planParams }), controller.get);
  router.patch('/:planId', authorization.requireRoles('admin'), validate({ params: schemas.planParams, body: schemas.updatePlan }), controller.update);
  return router;
}
module.exports = { createPlanRouter };
