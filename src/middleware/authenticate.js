function authenticate(service) {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [^ ]+$/i.test(header)) {
      const error = new Error('Authentication required.'); error.code = 'INVALID_AUTHENTICATION'; return next(error);
    }
    try { req.auth = await service.authenticate(header.slice(7)); return next(); }
    catch (error) { return next(error); }
  };
}
module.exports = authenticate;
