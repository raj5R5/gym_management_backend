const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { objectId } = require('../gyms/gym.validation');

const gymParams = z.strictObject({ gymId: objectId });
const receiptParams = z.strictObject({ gymId: objectId, paymentId: objectId });
const empty = z.strictObject({});

// Member-only reads; the service resolves the member from the signed-in account.
function createMemberHomeRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, authenticate(authService),
    validate({ params: gymParams.passthrough() }), authorization.requireGymAccess, authorization.requireRoles('member'));
  const send = (req, res, data) => res.json({ success: true, data, meta: { requestId: req.id } });
  router.get('/home', validate({ query: empty }), async (req, res) => send(req, res, await service.home(req.auth, req.authorization)));
  router.get('/payments/:paymentId/receipt', validate({ params: receiptParams, query: empty }), async (req, res) =>
    send(req, res, await service.receipt(req.auth, req.authorization, req.params.paymentId)));
  return router;
}
module.exports = { createMemberHomeRouter };
