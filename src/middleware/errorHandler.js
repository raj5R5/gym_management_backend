const publicErrors = {
  NOT_FOUND: [404, 'Route not found.'],
  CORS_ORIGIN_DENIED: [403, 'Origin is not allowed.'],
  RATE_LIMITED: [429, 'Too many requests. Please try again later.'],
};

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected server error occurred.';

  if (error.type === 'entity.parse.failed') {
    [status, code, message] = [400, 'INVALID_JSON', 'Request body must contain valid JSON.'];
  } else if (error.type === 'entity.too.large') {
    [status, code, message] = [413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the allowed size.'];
  } else if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
    [status, code, message] = [415, 'UNSUPPORTED_ENCODING', 'Request encoding is not supported.'];
  } else if (Object.hasOwn(publicErrors, error.code)) {
    [status, message] = publicErrors[error.code];
    code = error.code;
  }

  if (status >= 500) req.log?.error({ err: error, requestId: req.id }, 'Request failed');

  return res.status(status).json({
    success: false,
    error: { code, message },
    meta: { requestId: req.id },
  });
}

module.exports = errorHandler;
