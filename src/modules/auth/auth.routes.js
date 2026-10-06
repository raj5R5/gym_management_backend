const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const validate = require('../../middleware/validate');
const authenticate = require('../../middleware/authenticate');
const schemas = require('./auth.validation');
const { createAuthController } = require('./auth.controller');
function authLimiter(limit, windowMs = 15 * 60 * 1000) {
  return rateLimit({ limit, windowMs, standardHeaders: 'draft-8', legacyHeaders: false,
    handler(_req, _res, next) { const error = new Error('Too many requests.'); error.code = 'RATE_LIMITED'; next(error); } });
}
function createAuthRouter(service, config) {
  const router = Router();
  const controller = createAuthController(service, config);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/login', authLimiter(30), validate({ body: schemas.login }), controller.login);
  router.post('/refresh', authLimiter(60, 60 * 1000), validate({ body: schemas.refresh }), controller.refresh);
  router.post('/logout', validate({ body: schemas.refresh }), controller.logout);
  router.get('/me', authenticate(service), controller.me);
  return router;
}
module.exports = { createAuthRouter, authLimiter };
