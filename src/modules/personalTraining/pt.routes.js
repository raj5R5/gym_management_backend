const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const schemas = require('./pt.validation');

// Trainers reach packages and session logging only; the service narrows them to their own packages.
function createPtRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams.passthrough() }), authorization.requireGymAccess,
    authorization.requireRoles('admin', 'trainer'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  const limit = authLimiter(60, 60 * 1000);
  const onPackage = (method) => async (req, res) => send(req, res,
    await service[method](req.auth, req.authorization, req.params.packageId, req.validated.body), 201);
  router.get('/packages', validate({ query: schemas.packageListQuery }), async (req, res) =>
    send(req, res, await service.list(req.auth, req.authorization, req.query)));
  router.post('/packages', limit, validate({ body: schemas.createPackage }), async (req, res) =>
    send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201));
  router.get('/packages/:packageId', validate({ params: schemas.packageParams }), async (req, res) =>
    send(req, res, await service.get(req.auth, req.authorization, req.params.packageId)));
  router.post('/packages/:packageId/payments', limit, validate({ params: schemas.packageParams, body: schemas.payment }),
    onPackage('addPayment'));
  router.post('/packages/:packageId/sessions', limit, validate({ params: schemas.packageParams, body: schemas.logSession }),
    onPackage('logSession'));
  router.post('/packages/:packageId/cancel', limit, validate({ params: schemas.packageParams }), async (req, res) =>
    send(req, res, await service.cancel(req.auth, req.authorization, req.params.packageId)));
  router.get('/commissions', validate({ query: schemas.periodQuery }), async (req, res) =>
    send(req, res, await service.commissions(req.auth, req.authorization, req.query)));
  router.get('/rates', async (req, res) => send(req, res, await service.rates(req.auth, req.authorization)));
  router.put('/rates/:trainerId', limit, validate({ params: schemas.trainerParams, body: schemas.setRate }), async (req, res) =>
    send(req, res, await service.setRate(req.auth, req.authorization, req.params.trainerId, req.validated.body)));
  return router;
}
module.exports = { createPtRouter };
