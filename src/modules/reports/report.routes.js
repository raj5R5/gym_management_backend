const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { reportParams, reportQuery } = require('./report.validation');

function createReportRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams.passthrough() }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.get('/:kind', validate({ params: reportParams, query: reportQuery }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const data = await service.get(req.auth, req.authorization, req.params.kind, req.query);
    res.json({ success: true, data, meta: { requestId: req.id } });
  });
  return router;
}
module.exports = { createReportRouter };
