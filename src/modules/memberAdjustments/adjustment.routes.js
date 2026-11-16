const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const { adjustmentParams, freezeParams, createFreeze, createDiscount } = require('./adjustment.validation');

function createAdjustmentRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: adjustmentParams.passthrough() }),
    authorization.requireGymAccess, authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  router.get('/', async (req, res) => send(req, res, await service.get(req.auth, req.authorization, req.params.subscriptionId)));
  router.post('/freezes', authLimiter(30, 60 * 1000), validate({ body: createFreeze }), async (req, res) =>
    send(req, res, await service.freeze(req.auth, req.authorization, req.params.subscriptionId, req.validated.body), 201));
  router.post('/freezes/:freezeId/end', authLimiter(30, 60 * 1000), validate({ params: freezeParams }), async (req, res) =>
    send(req, res, await service.endFreeze(req.auth, req.authorization, req.params.subscriptionId, req.params.freezeId)));
  router.post('/discounts', authLimiter(30, 60 * 1000), validate({ body: createDiscount }), async (req, res) =>
    send(req, res, await service.discount(req.auth, req.authorization, req.params.subscriptionId, req.validated.body), 201));
  return router;
}
module.exports = { createAdjustmentRouter };
