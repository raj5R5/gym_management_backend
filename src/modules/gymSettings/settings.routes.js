const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const { updateSettings } = require('./settings.validation');

function createGymSettingsRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data) => res.json({ success: true, data, meta: { requestId: req.id } });
  router.get('/', async (req, res) => send(req, res, await service.get(req.auth, req.authorization)));
  router.patch('/', authLimiter(30), validate({ body: updateSettings }), async (req, res) =>
    send(req, res, await service.update(req.auth, req.authorization, req.validated.body)));
  return router;
}
module.exports = { createGymSettingsRouter };
