function bootstrapOnly(req, res, next) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    const error = new Error('Bootstrap routes are restricted to loopback clients.');
    error.code = 'BOOTSTRAP_FORBIDDEN';
    return next(error);
  }
  res.setHeader('X-API-Mode', 'development-bootstrap');
  return next();
}

module.exports = bootstrapOnly;
