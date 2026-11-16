const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { objectId } = require('../gyms/gym.validation');

const receiptParams = z.strictObject({ gymId: objectId, paymentId: objectId });
function createReceiptRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.get('/', authenticate(authService), validate({ params: receiptParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'), async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const data = await service.get(req.auth, req.authorization, req.params.paymentId);
      res.json({ success: true, data, meta: { requestId: req.id } });
    });
  return router;
}
module.exports = { createReceiptRouter };
