const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./member.validation');
const { createMemberController } = require('./member.controller');
function createMemberRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  const controller = createMemberController(service);
  router.use(authenticate(authService));
  router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createMember }), controller.create);
  router.get('/', authorization.requireRoles('admin', 'trainer'), validate({ query: schemas.memberListQuery }), controller.list);
  router.get('/:memberId', authorization.requireRoles('admin', 'trainer'),
    validate({ params: schemas.memberParams }), controller.get);
  router.patch('/:memberId', authorization.requireRoles('admin'),
    validate({ params: schemas.memberParams, body: schemas.updateMember }), controller.update);
  return router;
}
module.exports = { createMemberRouter };
