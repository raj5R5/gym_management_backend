const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const schemas = require('./account.validation');
const { createMemberAccountController } = require('./account.controller');
const noStore = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
function createMemberAccountRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createMemberAccountController(service);
  router.use(noStore, authenticate(authService), validate({ params: schemas.memberParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.post('/', validate({ params: schemas.memberParams, body: schemas.provision, query: schemas.empty }), controller.provision);
  router.get('/', validate({ params: schemas.memberParams, query: schemas.empty }), controller.get);
  router.post('/revoke', validate({ params: schemas.memberParams, body: schemas.empty.default({}), query: schemas.empty }), controller.revoke);
  return router;
}
function createAccountActivationRouter(service) {
  const router = Router(); const controller = createMemberAccountController(service);
  router.post('/activate', noStore, authLimiter(20), validate({ body: schemas.activate, query: schemas.empty }), controller.activate);
  return router;
}
module.exports = { createMemberAccountRouter, createAccountActivationRouter };
