const publicErrors = {
  INVALID_CREDENTIALS: [401, 'Invalid email or password.'],
  INVALID_AUTHENTICATION: [401, 'Authentication is invalid or expired.'],
  FORBIDDEN: [403, 'You do not have permission to perform this operation.'],
  PASSWORD_ALREADY_SET: [409, 'Password has already been provisioned.'],
  NOT_FOUND: [404, 'Route not found.'],
  GYM_NOT_FOUND: [404, 'Gym not found.'],
  MEMBER_NOT_FOUND: [404, 'Member not found.'],
  TRAINER_NOT_FOUND: [404, 'Trainer not found.'],
  ASSIGNMENT_NOT_FOUND: [404, 'Assignment not found.'],
  BRANCH_NOT_FOUND: [404, 'Branch not found.'],
  USER_ACCOUNT_NOT_FOUND: [404, 'User account not found.'],
  GYM_ACCESS_NOT_FOUND: [404, 'Gym access not found.'],
  VALIDATION_ERROR: [400, 'Request validation failed.'],
  BOOTSTRAP_FORBIDDEN: [403, 'Bootstrap routes require a local development client.'],
  CORS_ORIGIN_DENIED: [403, 'Origin is not allowed.'],
  RATE_LIMITED: [429, 'Too many requests. Please try again later.'],
};

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected server error occurred.';

  if (error.code === 11000) {
    if (error.keyPattern?.gymId && error.keyPattern?.trainerId && error.keyPattern?.memberId) {
      [status, code, message] = [409, 'DUPLICATE_ACTIVE_ASSIGNMENT', 'An active assignment already exists for this relationship.'];
    } else if (error.keyPattern?.trainerCode && error.keyPattern?.gymId) {
      [status, code, message] = [409, 'DUPLICATE_TRAINER_CODE', 'Trainer code already exists in this gym.'];
    } else if (error.keyPattern?.memberCode && error.keyPattern?.gymId) {
      [status, code, message] = [409, 'DUPLICATE_MEMBER_CODE', 'Member code already exists in this gym.'];
    } else if (error.keyPattern?.normalizedEmail) {
      [status, code, message] = [409, 'DUPLICATE_EMAIL', 'An account with this email already exists.'];
    } else if (error.keyPattern?.userId && error.keyPattern?.gymId) {
      [status, code, message] = [409, 'DUPLICATE_GYM_ACCESS', 'This account already has access to this gym.'];
    } else {
      [status, code, message] = [409, 'DUPLICATE_NAME', 'Name already exists in this scope.'];
    }
  } else if (error.type === 'entity.parse.failed') {
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
