const { Router } = require('express');
const validate = require('../../middleware/validate');
const { listQuery } = require('../gyms/gym.validation');
const schemas = require('./userAccount.validation');
const { createUserAccountController } = require('./userAccount.controller');

// Local provisioning/inspection only; never public self-registration.
function createUserAccountRouter(service) {
  const router = Router();
  const controller = createUserAccountController(service);
  router.post('/', validate({ body: schemas.createUserAccount }), controller.create);
  router.get('/', validate({ query: listQuery }), controller.list);
  router.get('/:userId', validate({ params: schemas.userParams }), controller.get);
  return router;
}

module.exports = { createUserAccountRouter };
