const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { objectId } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const schemas = require('./claim.validation');

const gymParams = z.strictObject({ gymId: objectId });
const empty = z.strictObject({});
const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
const noStore = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

// Member: report a UPI payment and see recent reports.
function createMemberClaimRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(noStore, authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('member'));
  router.get('/', validate({ query: empty }), async (req, res) => send(req, res, await service.mine(req.auth, req.authorization)));
  router.post('/', authLimiter(60, 15 * 60 * 1000), validate({ body: schemas.createClaim }), async (req, res) =>
    send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201));
  return router;
}
// Owner: review, confirm into a payment, or reject.
function createAdminClaimRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(noStore, authenticate(authService), validate({ params: gymParams.passthrough() }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.get('/', validate({ query: schemas.claimListQuery }), async (req, res) =>
    send(req, res, await service.list(req.auth, req.authorization, req.query)));
  router.post('/:claimId/confirm', validate({ params: schemas.claimParams, body: empty.default({}) }), async (req, res) =>
    send(req, res, await service.confirm(req.auth, req.authorization, req.params.claimId)));
  router.post('/:claimId/reject', validate({ params: schemas.claimParams, body: schemas.rejectClaim }), async (req, res) =>
    send(req, res, await service.reject(req.auth, req.authorization, req.params.claimId, req.validated.body)));
  return router;
}
module.exports = { createMemberClaimRouter, createAdminClaimRouter };
