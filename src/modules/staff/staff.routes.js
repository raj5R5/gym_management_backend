const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./staff.validation');
const { createStaffController } = require('./staff.controller');
function createStaffRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createStaffController(service);
  router.use(authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess, authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', validate({ body: schemas.createStaff }), controller.create);
  router.get('/', validate({ query: schemas.staffListQuery }), controller.list);
  router.get('/:userId', validate({ params: schemas.staffParams }), controller.get);
  router.patch('/:userId', validate({ params: schemas.staffParams, body: schemas.updateStaff }), controller.update);
  return router;
}
module.exports = { createStaffRouter };
