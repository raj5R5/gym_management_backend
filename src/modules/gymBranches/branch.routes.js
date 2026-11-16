const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const { createBranch, summaryQuery } = require('./branch.validation');

// Account-level (not under one gym): the owner's own gyms.
function createBranchRouter(service, authService) {
  const router = Router();
  router.use(authenticate(authService));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  router.get('/summary', validate({ query: summaryQuery }), async (req, res) =>
    send(req, res, await service.summary(req.auth, req.query)));
  router.post('/', authLimiter(10, 60 * 60 * 1000), validate({ body: createBranch }), async (req, res) =>
    send(req, res, await service.create(req.auth, req.validated.body), 201));
  return router;
}
module.exports = { createBranchRouter };
