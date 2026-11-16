const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { overviewQuery, birthdayQuery } = require('./overview.validation');

function createMemberOverviewRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.get('/', authenticate(authService), validate({ params: gymParams, query: overviewQuery }),
    authorization.requireGymAccess, authorization.requireRoles('admin'), async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const data = await service.list(req.auth, req.authorization, req.query);
      res.json({ success: true, data, meta: { requestId: req.id } });
    });
  router.get('/birthdays', authenticate(authService), validate({ params: gymParams, query: birthdayQuery }),
    authorization.requireGymAccess, authorization.requireRoles('admin'), async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const data = await service.birthdays(req.auth, req.authorization, req.query);
      res.json({ success: true, data, meta: { requestId: req.id } });
    });
  return router;
}
module.exports = { createMemberOverviewRouter };
