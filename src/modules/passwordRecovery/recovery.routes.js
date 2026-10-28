const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { createHash } = require('node:crypto');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const { password } = require('../auth/auth.validation');
const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const requestBody = z.strictObject({ email: z.string().trim().pipe(z.email().max(254)) });
const completeBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newPassword: password });
function createRecoveryRouter(service) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const accountLimit = rateLimit({ limit: 3, windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => createHash('sha256').update(normalizeEmail(req.validated.body.email)).digest('hex'),
    handler(_req, _res, next) { const error = new Error('Too many requests.'); error.code = 'RATE_LIMITED'; next(error); } });
  router.post('/password-recovery/request', authLimiter(10), validate({ body: requestBody }), accountLimit,
    (req, res) => {
      service.request(req.validated.body.email);
      res.status(202).json({ success: true, data: { accepted: true }, meta: { requestId: req.id } });
    });
  router.post('/password-recovery/complete', authLimiter(10), validate({ body: completeBody }), async (req, res) => {
    const { token, newPassword } = req.validated.body;
    res.json({ success: true, data: await service.complete(token, newPassword), meta: { requestId: req.id } });
  });
  return router;
}
module.exports = { createRecoveryRouter };
