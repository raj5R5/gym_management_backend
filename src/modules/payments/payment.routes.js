const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./payment.validation');
const { createPaymentController } = require('./payment.controller');
function createPaymentRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createPaymentController(service);
  router.use(authenticate(authService)); router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const readGuard = async (req, _res, next) => {
    try { await service.authorizeRead(req.auth, req.authorization, req.validated.params?.paymentId); next(); }
    catch (error) { next(error); }
  };
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createPayment, headers: schemas.paymentHeaders }), controller.create);
  router.get('/', authorization.requireRoles('admin', 'trainer'), validate({ query: schemas.paymentListQuery }), readGuard, controller.list);
  router.get('/:paymentId', authorization.requireRoles('admin', 'trainer'), validate({ params: schemas.paymentParams }), readGuard, controller.get);
  return router;
}
module.exports = { createPaymentRouter };
