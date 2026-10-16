const { Router } = require('express');
const multer = require('multer');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { memberParams } = require('../members/member.validation');
const { MAX_PHOTO_BYTES, fail } = require('./photo.image');
function createPhotoRouter(service, authService, authorization) {
  const router = Router({ mergeParams: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: MAX_PHOTO_BYTES, files: 1, fields: 0, parts: 1,
  } }).single('photo');
  router.use(authenticate(authService), validate({ params: memberParams }), authorization.requireGymAccess);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const preflight = async (req, _res, next) => {
    await service.access(req.auth, req.authorization, req.validated.params.memberId, true); next();
  };
  const multipart = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next(Object.assign(new Error('Photo form required.'), { code: 'PHOTO_INVALID_IMAGE' }));
    upload(req, res, (error) => {
      if (!error) return next();
      return next(Object.assign(new Error('Photo form rejected.'), {
        code: error.code === 'LIMIT_FILE_SIZE' ? 'PHOTO_TOO_LARGE' : 'PHOTO_INVALID_IMAGE',
      }));
    });
  };
  const send = (req, res, data) => res.json({ success: true, data, meta: { requestId: req.id } });
  router.get('/operations/:operationKey', authorization.requireRoles('admin'), async (req, res) =>
    send(req, res, await service.status(req.auth, req.authorization, req.validated.params.memberId, req.params.operationKey)));
  router.get('/', authorization.requireRoles('admin', 'trainer'), async (req, res) => {
    const bytes = await service.read(req.auth, req.authorization, req.validated.params.memberId);
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  });
  router.put('/', authorization.requireRoles('admin'), preflight, multipart, async (req, res) => {
    if (!req.file) fail('PHOTO_INVALID_IMAGE');
    return send(req, res, await service.upload(req.auth, req.authorization,
      req.validated.params.memberId, req.get('Idempotency-Key'), req.file));
  });
  router.delete('/', authorization.requireRoles('admin'), preflight, async (req, res) =>
    send(req, res, await service.remove(req.auth, req.authorization,
      req.validated.params.memberId, req.get('Idempotency-Key'))));
  return router;
}
module.exports = { createPhotoRouter };
