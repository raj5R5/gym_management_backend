const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const { checkIn, memberVisitParams, visitListQuery } = require('./visit.validation');

function createMemberVisitRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  router.post('/', authLimiter(120, 60 * 1000), validate({ body: checkIn }), async (req, res) => {
    const data = await service.checkIn(req.auth, req.authorization, req.validated.body);
    send(req, res, data, data.alreadyCheckedIn ? 200 : 201);
  });
  router.get('/today', validate({ query: visitListQuery }), async (req, res) =>
    send(req, res, await service.today(req.auth, req.authorization, req.query)));
  return router;
}

function createMemberVisitHistoryRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.get('/', authenticate(authService), validate({ params: memberVisitParams, query: visitListQuery }),
    authorization.requireGymAccess, authorization.requireRoles('admin'), async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const data = await service.memberHistory(req.auth, req.authorization, req.params.memberId, req.query);
      res.json({ success: true, data, meta: { requestId: req.id } });
    });
  return router;
}
module.exports = { createMemberVisitRouter, createMemberVisitHistoryRouter };
