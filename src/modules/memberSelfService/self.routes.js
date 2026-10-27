const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const schemas = require('./self.validation');
const { createMemberSelfController } = require('./self.controller');
function createMemberSelfRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createMemberSelfController(service);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, authenticate(authService),
    validate({ params: schemas.gymParams }), authorization.requireGymAccess, authorization.requireRoles('member'));
  for (const kind of ['profile', 'membership', 'payments', 'trainers']) router.get('/'+kind,
    validate({ query: kind === 'profile' ? schemas.empty : schemas.listQuery, body: schemas.empty.default({}) }), controller(kind));
  return router;
}
module.exports = { createMemberSelfRouter };
