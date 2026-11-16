const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const { createExpense, expenseParams, expenseListQuery } = require('./expense.validation');

function createExpenseRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams.passthrough() }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data, status = 200) => res.status(status).json({ success: true, data, meta: { requestId: req.id } });
  router.get('/', validate({ query: expenseListQuery }), async (req, res) =>
    send(req, res, await service.list(req.auth, req.authorization, req.query)));
  router.post('/', authLimiter(60, 60 * 1000), validate({ body: createExpense }), async (req, res) =>
    send(req, res, await service.create(req.auth, req.authorization, req.validated.body), 201));
  router.delete('/:expenseId', validate({ params: expenseParams }), async (req, res) =>
    send(req, res, await service.remove(req.auth, req.authorization, req.params.expenseId)));
  return router;
}
module.exports = { createExpenseRouter };
