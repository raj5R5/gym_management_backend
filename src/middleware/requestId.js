const { randomUUID } = require('node:crypto');

const safeRequestId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requestId(req, res, next) {
  const supplied = req.headers['x-request-id'];
  req.id = typeof supplied === 'string' && safeRequestId.test(supplied)
    ? supplied
    : randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
}

module.exports = requestId;
