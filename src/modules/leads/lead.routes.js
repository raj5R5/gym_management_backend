const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const schemas = require('./lead.validation');

function createLeadRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams.passthrough() }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  const limit = authLimiter(60, 60 * 1000);
  router.get('/', validate({ query: schemas.leadListQuery }), async (req, res) =>
    send(req, res, await service.list(req.auth, req.authorization, req.query)));
  router.get('/referrals', async (req, res) => send(req, res, await service.referrals(req.auth, req.authorization)));
  router.post('/', limit, validate({ body: schemas.createLead }), async (req, res) =>
    send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201));
  router.get('/:leadId', validate({ params: schemas.leadParams }), async (req, res) =>
    send(req, res, await service.get(req.auth, req.authorization, req.params.leadId)));
  router.patch('/:leadId', limit, validate({ params: schemas.leadParams, body: schemas.updateLead }), async (req, res) =>
    send(req, res, await service.update(req.auth, req.authorization, req.params.leadId, req.validated.body)));
  router.post('/:leadId/notes', limit, validate({ params: schemas.leadParams, body: schemas.addNote }), async (req, res) =>
    send(req, res, await service.addNote(req.auth, req.authorization, req.params.leadId, req.validated.body), 201));
  router.post('/:leadId/trial', limit, validate({ params: schemas.leadParams, body: schemas.startTrial }), async (req, res) =>
    send(req, res, await service.startTrial(req.auth, req.authorization, req.params.leadId, req.validated.body)));
  router.post('/:leadId/convert', limit, validate({ params: schemas.leadParams, body: schemas.convertLead }), async (req, res) =>
    send(req, res, await service.convert(req.auth, req.authorization, req.params.leadId, req.validated.body)));
  return router;
}
module.exports = { createLeadRouter };
