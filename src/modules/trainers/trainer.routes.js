const { Router } = require('express');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const schemas = require('./trainer.validation');
const { createTrainerController } = require('./trainer.controller');
function createTrainerRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  const controller = createTrainerController(service);
  router.use(authenticate(authService));
  router.use(validate({ params: gymParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', authorization.requireRoles('admin'), validate({ body: schemas.createTrainer }), controller.create);
  router.get('/', authorization.requireRoles('admin'), validate({ query: schemas.trainerListQuery }), controller.list);
  router.get('/:trainerId', authorization.requireRoles('admin'),
    validate({ params: schemas.trainerParams }), controller.get);
  router.patch('/:trainerId', authorization.requireRoles('admin'),
    validate({ params: schemas.trainerParams, body: schemas.updateTrainer }), controller.update);
  return router;
}
module.exports = { createTrainerRouter };
