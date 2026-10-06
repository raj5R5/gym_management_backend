function notFound(_req, _res, next) {
  const error = new Error('Route not found.');
  error.code = 'NOT_FOUND';
  error.status = 404;
  next(error);
}

module.exports = notFound;
