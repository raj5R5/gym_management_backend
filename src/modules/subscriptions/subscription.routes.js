const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./subscription.validation');
const { createSubscriptionController } = require('./subscription.controller');
function createSubscriptionRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createSubscriptionController(service);
  router.use(authenticate(authService));
  router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const readGuard = async (req, _res, next) => {
    try { await service.authorizeRead(req.auth, req.authorization, req.validated.params?.subscriptionId); next(); }
    catch (error) { next(error); }
  };
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createSubscription }), controller.create);
  router.get('/', authorization.requireRoles('admin', 'trainer'), validate({ query: schemas.subscriptionListQuery }), readGuard, controller.list);
  router.get('/:subscriptionId', authorization.requireRoles('admin', 'trainer'), validate({ params: schemas.subscriptionParams }), readGuard, controller.get);
  router.patch('/:subscriptionId/cancel', authorization.requireRoles('admin'),
    validate({ params: schemas.subscriptionParams, body: schemas.cancelSubscription }), controller.cancel);
  return router;
}
module.exports = { createSubscriptionRouter };
