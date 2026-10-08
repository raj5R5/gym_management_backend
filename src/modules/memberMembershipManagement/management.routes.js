const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const schemas = require('./management.validation');
const { createMembershipManagementController } = require('./management.controller');
function createMembershipManagementRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createMembershipManagementController(service);
  router.use(authenticate(authService), validate({ params: schemas.memberParams }), authorization.requireGymAccess, authorization.requireRoles('admin', 'trainer'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', validate({ query: schemas.historyQuery }), controller.list);
  router.get('/:subscriptionId', validate({ params: schemas.itemParams, query: schemas.emptyQuery }), controller.get);
  router.post('/:subscriptionId/cancel', validate({ params: schemas.itemParams, query: schemas.emptyQuery, body: schemas.cancelSubscription }), controller.cancel);
  return router;
}
module.exports = { createMembershipManagementRouter };
