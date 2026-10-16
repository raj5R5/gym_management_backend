const { Router } = require('express');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const { registerOwner } = require('./registration.validation');
const { createOwnerRegistrationController } = require('./registration.controller');

function createOwnerRegistrationRouter(service) {
  const router = Router();
  router.post('/register-owner', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); },
    authLimiter(5), validate({ body: registerOwner }), createOwnerRegistrationController(service).register);
  return router;
}
module.exports = { createOwnerRegistrationRouter };
