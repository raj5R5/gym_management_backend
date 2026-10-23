const { Router } = require('express');
const multer = require('multer');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { gymParams } = require('../gyms/gym.validation');
const { authLimiter } = require('../auth/auth.routes');
const { MAX_PHOTO_BYTES, fail } = require('../memberPhotos/photo.image');
const { updateProfile } = require('./profile.validation');
function createOwnerProfileRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  router.use(authenticate(authService), validate({ params: gymParams }), authorization.requireGymAccess,
    authorization.requireRoles('admin'));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const send = (req, res, data) => res.json({ success: true, data, meta: { requestId: req.id } });
  router.get('/', async (req, res) => send(req, res, await service.get(req.auth, req.authorization)));
  router.patch('/', authLimiter(20), validate({ body: updateProfile }), async (req, res) =>
    send(req, res, await service.update(req.auth, req.authorization, req.validated.body)));
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0, parts: 1,
  } }).single('photo');
  const preflight = async (req, _res, next) => {
    req.ownerProfile = await service.access(req.auth, req.authorization); next();
  };
  router.get('/photo/operations/:operationKey', preflight, async (req, res) =>
    send(req, res, await service.photos.status(req.auth, req.authorization, req.ownerProfile._id, req.params.operationKey)));
  router.get('/photo', preflight, async (req, res) => {
    const bytes = await service.photos.read(req.auth, req.authorization, req.ownerProfile._id);
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.send(bytes);
  });
  router.put('/photo', authLimiter(30), preflight, (req, res, next) => {
    if (!req.is('multipart/form-data')) return next(Object.assign(new Error('Photo form required.'), { code: 'PHOTO_INVALID_IMAGE' }));
    return upload(req, res, (error) => {
      if (error) return next(Object.assign(new Error('Photo form rejected.'), {
        code: error.code === 'LIMIT_FILE_SIZE' ? 'PHOTO_TOO_LARGE' : 'PHOTO_INVALID_IMAGE' }));
      return next();
    });
  }, async (req, res) => {
    if (!req.file) fail('PHOTO_INVALID_IMAGE');
    return send(req, res, await service.photos.upload(req.auth, req.authorization,
      req.ownerProfile._id, req.get('Idempotency-Key'), req.file));
  });
  router.delete('/photo', authLimiter(30), preflight, async (req, res) =>
    send(req, res, await service.photos.remove(req.auth, req.authorization, req.ownerProfile._id, req.get('Idempotency-Key'))));
  return router;
}
module.exports = { createOwnerProfileRouter };
