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
  PLAN_NOT_FOUND: [404, 'Membership plan not found.'],
  ATTENDANCE_NOT_FOUND: [404, 'Attendance not found.'],
  ATTENDANCE_BRANCH_INACTIVE: [409, 'Branch is not active for check-in.'],
  ATTENDANCE_BRANCH_MISMATCH: [409, 'Member is not assigned to this branch.'],
  ATTENDANCE_MEMBERSHIP_REQUIRED: [409, 'A currently valid subscription is required for check-in.'],
  ATTENDANCE_MEMBERSHIP_AMBIGUOUS: [409, 'Membership eligibility is inconsistent; check-in is denied.'],
  ATTENDANCE_ALREADY_OPEN: [409, 'Member already has an open visit in this gym.'],
  ATTENDANCE_NOT_OPEN: [409, 'Attendance is no longer open.'],
  STAFF_NOT_FOUND: [404, 'Staff member not found.'],
  LAST_ACTIVE_ADMIN: [409, 'The gym must retain at least one active administrator with an active account and provisioned credentials.'],
  STAFF_STORAGE_UNAVAILABLE: [503, 'Staff changes require transaction-capable database storage.'],
  MEMBER_ACCOUNT_STORAGE_UNAVAILABLE: [503, 'Member account changes require transaction-capable database storage.'],
  MEMBER_ACCOUNT_IDENTITY_CONFLICT: [409, 'The email or member is already linked to another identity.'],
  MEMBER_ACCOUNT_ALREADY_PROVISIONED: [409, 'Member login access is already provisioned.'],
  MEMBER_ACCOUNT_NOT_PROVISIONED: [404, 'Member login access has not been provisioned.'],
  INVALID_ACTIVATION_CREDENTIAL: [401, 'Activation credential is invalid or expired.'],
  DUPLICATE_GYM_ACCESS: [409, 'This account already has access to this gym.'],
  PAYMENT_NOT_FOUND: [404, 'Payment not found.'],
  PAYMENT_MEMBER_MISMATCH: [400, 'Subscription does not belong to the specified member.'],
  PAYMENT_SUBSCRIPTION_CANCELLED: [409, 'Cannot record payment against a cancelled subscription.'],
  PAYMENT_OVERPAYMENT: [409, 'Payment exceeds the remaining subscription amount.'],
  PAYMENT_STORAGE_UNAVAILABLE: [503, 'Payment recording requires transaction-capable database storage.'],
  SUBSCRIPTION_NOT_FOUND: [404, 'Subscription not found.'],
  SUBSCRIPTION_ALREADY_RENEWED: [409, 'Subscription already has a direct successor. Renew the latest subscription instead.'],
  SUBSCRIPTION_CANCELLED: [409, 'A cancelled subscription cannot be renewed.'],
  SUBSCRIPTION_OVERLAP: [409, 'Subscription period overlaps an existing non-cancelled subscription.'],
  SUBSCRIPTION_STORAGE_UNAVAILABLE: [503, 'Subscription creation requires transaction-capable database storage.'],
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
    if (error.keyPattern?.gymId && error.keyPattern?.memberId && !error.keyPattern?.trainerId) {
      [status, code, message] = [409, 'ATTENDANCE_ALREADY_OPEN', 'Member already has an open visit in this gym.'];
    } else if (error.keyPattern?.gymId && error.keyPattern?.paymentMethod && error.keyPattern?.transactionReference) {
      [status, code, message] = [409, 'DUPLICATE_PAYMENT_REFERENCE', 'A successful payment with this reference already exists for this method in this gym.'];
    } else if (error.keyPattern?.gymId && error.keyPattern?.normalizedName) {
      [status, code, message] = [409, 'DUPLICATE_PLAN_NAME', 'Plan name already exists in this gym.'];
    } else if (error.keyPattern?.gymId && error.keyPattern?.trainerId && error.keyPattern?.memberId) {
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
