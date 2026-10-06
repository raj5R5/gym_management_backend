const { Router } = require('express');
const validate = require('../../middleware/validate');
const { gymParams, listQuery } = require('../gyms/gym.validation');
const schemas = require('./branch.validation');
const { createBranchController } = require('./branch.controller');

function createBranchRouter(service) {
  const router = Router({ mergeParams: true });
  const controller = createBranchController(service);
  router.post('/', validate({ params: gymParams, body: schemas.createBranch }), controller.create);
  router.get('/', validate({ params: gymParams, query: listQuery }), controller.list);
  router.get('/:branchId', validate({ params: schemas.branchParams }), controller.get);
  router.patch('/:branchId', validate({ params: schemas.branchParams, body: schemas.updateBranch }), controller.update);
  return router;
}

module.exports = { createBranchRouter };
