const { Router } = require('express');
const validate = require('../../middleware/validate');
const schemas = require('./gym.validation');
const { createGymController } = require('./gym.controller');
const { createBranchRouter } = require('../branches/branch.routes');

// Mounted only behind the development bootstrap gate in app.js.
function createGymRouter(gymService, branchService) {
  const router = Router();
  const controller = createGymController(gymService);
  router.post('/', validate({ body: schemas.createGym }), controller.create);
  router.get('/', validate({ query: schemas.listQuery }), controller.list);
  router.get('/:gymId', validate({ params: schemas.gymParams }), controller.get);
  router.patch('/:gymId', validate({ params: schemas.gymParams, body: schemas.updateGym }), controller.update);
  router.use('/:gymId/branches', createBranchRouter(branchService));
  return router;
}

module.exports = { createGymRouter };
