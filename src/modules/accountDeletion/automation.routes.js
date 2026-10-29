const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { authLimiter } = require('../auth/auth.routes');
const { objectId } = require('../gyms/gym.validation');

const password = z.string().min(1).max(128);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emptyQuery = z.strictObject({});
const schemas = {
  preview: z.strictObject({ currentPassword: password, choices: z.array(z.unknown()).max(50) }),
  accept: z.strictObject({ currentPassword: password, jobId: objectId, gymId: objectId }),
  confirm: z.strictObject({ jobId: objectId, token, acknowledgement: z.literal('DELETE_MY_ACCOUNT'), closeGymIds: z.array(objectId).max(50) }),
  status: z.strictObject({ id: objectId, statusToken: token }),
};
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store'); next(); }
// authenticate() has already validated the Bearer header shape.
const bearer = (req) => req.headers.authorization.slice(7);
const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });

function createAccountDeletionAutomationRouter(engine, authService) {
  const router = Router();
  router.use('/account-deletion', noStore);
  const auth = authenticate(authService);
  router.get('/account-deletion/options', auth, validate({ query: emptyQuery }), async (req, res) => {
    send(req, res, await engine.options(bearer(req)));
  });
  router.post('/account-deletion/preview', auth, authLimiter(10), validate({ body: schemas.preview }), async (req, res) => {
    const { currentPassword, choices } = req.validated.body;
    send(req, res, { preview: await engine.preview(bearer(req), currentPassword, choices) });
  });
  router.post('/account-deletion/confirm', auth, authLimiter(10), validate({ body: schemas.confirm }), async (req, res) => {
    const { jobId, ...input } = req.validated.body;
    send(req, res, { job: await engine.confirm(bearer(req), jobId, input) }, 202);
  });
  router.get('/account-deletion/handoffs', auth, validate({ query: emptyQuery }), async (req, res) => {
    send(req, res, { handoffs: await engine.handoffs(bearer(req)) });
  });
  router.post('/account-deletion/handoffs/accept', auth, authLimiter(10), validate({ body: schemas.accept }), async (req, res) => {
    const { currentPassword, jobId, gymId } = req.validated.body;
    send(req, res, await engine.acceptTransfer(bearer(req), currentPassword, jobId, gymId));
  });
  // No login: the account may already be erased. The status proof is in the body, never the URL.
  router.post('/account-deletion/status', authLimiter(60), validate({ body: schemas.status }), async (req, res) => {
    send(req, res, { job: await engine.status(req.validated.body.id, req.validated.body.statusToken) });
  });
  return router;
}
module.exports = { createAccountDeletionAutomationRouter, schemas };
