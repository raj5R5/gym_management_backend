const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { purchaseMembership } = require('./membership.validation');
const { createMemberMembershipController } = require('./membership.controller');
function createMemberMembershipRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createMemberMembershipController(service);
  router.post('/', authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin', 'trainer'), validate({ body: purchaseMembership }),
    (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, controller.create);
  return router;
}
module.exports = { createMemberMembershipRouter };
