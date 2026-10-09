const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { completeOnboarding, completeHeaders } = require('./complete.validation');
const { createCompleteOnboardingController } = require('./complete.controller');
function createCompleteOnboardingRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createCompleteOnboardingController(service);
  router.post('/complete', authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'), validate({ body: completeOnboarding, headers: completeHeaders }),
    (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, controller.complete);
  return router;
}
module.exports = { createCompleteOnboardingRouter };
