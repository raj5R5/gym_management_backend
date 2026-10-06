const { Router } = require('express');
const validate = require('../../middleware/validate');
const { gymParams, listQuery } = require('../gyms/gym.validation');
const schemas = require('./gymAccess.validation');
const { createGymAccessController } = require('./gymAccess.controller');

function createGymAccessRouter(service) {
  const router = Router({ mergeParams: true });
  const controller = createGymAccessController(service);
  router.post('/', validate({ params: gymParams, body: schemas.createGymAccess }), controller.create);
  router.get('/', validate({ params: gymParams, query: listQuery }), controller.list);
  router.get('/:accessId', validate({ params: schemas.accessParams }), controller.get);
  return router;
}

module.exports = { createGymAccessRouter };
