const { Router } = require('express');
const { createAuthController } = require('../auth/auth.controller');
const { authLimiter } = require('../auth/auth.routes');
const authSchemas = require('../auth/auth.validation');
const validate = require('../../middleware/validate');
const { listQuery } = require('../gyms/gym.validation');
const schemas = require('./userAccount.validation');
const { createUserAccountController } = require('./userAccount.controller');

// Local provisioning/inspection only; never public self-registration.
function createUserAccountRouter(service, authService, config) {
  const router = Router();
  const controller = createUserAccountController(service);
  router.post('/:userId/password', authLimiter(20),
    validate({ params: authSchemas.userParams, body: authSchemas.provision }),
    createAuthController(authService, config).provision);
  router.post('/', validate({ body: schemas.createUserAccount }), controller.create);
  router.get('/', validate({ query: listQuery }), controller.list);
  router.get('/:userId', validate({ params: schemas.userParams }), controller.get);
  return router;
}

module.exports = { createUserAccountRouter };
