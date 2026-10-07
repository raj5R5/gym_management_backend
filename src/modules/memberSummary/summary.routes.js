const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const schemas = require('./summary.validation');
const { createMemberSummaryController } = require('./summary.controller');
function createMemberSummaryRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true }); const controller = createMemberSummaryController(service);
  router.get('/:memberId/summary', authenticate(authService), validate({ params: schemas.summaryParams, query: schemas.summaryQuery }),
    authorization.requireGymAccess, authorization.requireRoles('admin', 'trainer'),
    async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try { await service.authorizeRead(req.auth, req.authorization, req.validated.params.memberId); next(); }
      catch (error) { next(error); }
    }, controller.get);
  return router;
}
module.exports = { createMemberSummaryRouter };
