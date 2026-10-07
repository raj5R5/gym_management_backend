const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { dashboardParams, dashboardQuery } = require('./dashboard.validation');
const { createDashboardController } = require('./dashboard.controller');
function createDashboardRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createDashboardController(service);
  router.get('/', authenticate(authService), validate({ params: dashboardParams, query: dashboardQuery }),
    authorization.requireGymAccess, authorization.requireRoles('admin'),
    (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, controller.get);
  return router;
}
module.exports = { createDashboardRouter };
