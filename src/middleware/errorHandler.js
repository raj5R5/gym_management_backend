const publicErrors = {
  INVALID_RECOVERY_CREDENTIAL: [401, 'Recovery code is invalid or expired. Request a new code.'],
  PASSWORD_RECOVERY_UNAVAILABLE: [503, 'Account recovery delivery is unavailable. Retry later or contact support.'],
  PASSWORD_RECOVERY_STORAGE_UNAVAILABLE: [503, 'The password change could not be confirmed. Try signing in before requesting another code.'],
  MINOR_MEMBER_WORKFLOW_UNAVAILABLE: [409, 'Under-18 registration, profile changes and photo uploads are unavailable until guardian authorization and verification are supported.'],
  ACCOUNT_DELETION_PASSWORD_INVALID: [400, 'The current password is incorrect. No new deletion request was saved.'],
  ACCOUNT_DELETION_UPDATE_REQUIRED: [409, 'Account deletion now uses review and confirmation. Update MuscleDesk or use the public deletion page.'],
  DELETION_REQUEST_NOT_FOUND: [404, 'No open deletion request was found.'],
  DELETION_PASSWORD_INVALID: [400, 'The current password is incorrect. Nothing was deleted.'],
  DELETION_SCOPE_INVALID: [409, 'Your gym choices do not match your current gym access. Reload and review again.'],
  DELETION_SCOPE_CHANGED: [409, 'Your account or gym ownership changed. Review the deletion again.'],
  DELETION_OWNERSHIP_HANDOFF_REQUIRED: [409, 'This gym needs another active owner, a selected successor or a selected closure.'],
  DELETION_OTHER_OWNERS_PRESENT: [409, 'Other owners still run this gym. Leave it instead of closing it.'],
  DELETION_PENDING_OPERATIONS: [409, 'A photo upload is still processing. Retry in a few minutes.'],
  DELETION_EXISTING_REVIEW_REQUIRED: [409, 'An earlier deletion review for this account must finish first.'],
  DELETION_ALREADY_QUEUED: [409, 'Deletion of this account is already confirmed and in progress.'],
  DELETION_CONFIRMATION_INVALID: [409, 'This review expired or was replaced. Review the deletion again.'],
  DELETION_CLOSURE_CONFIRMATION_REQUIRED: [400, 'Confirm each gym you chose to close.'],
  DELETION_HANDOFF_ACCEPTANCE_REQUIRED: [409, 'The selected successor has not accepted ownership yet.'],
  PROFILE_PASSWORD_REQUIRED: [400, 'Enter your current password to change the sign-in email.'],
  PROFILE_PASSWORD_INVALID: [400, 'The current password is incorrect. No profile changes were saved.'],
  PROFILE_CHANGED: [409, 'Your account changed. Reload the profile before saving again.'],
  PHOTO_STORAGE_UNAVAILABLE: [503, 'Photo storage is unavailable. Retry later; the existing photo is unchanged.'],
  PHOTO_DATABASE_UNAVAILABLE: [503, 'The photo update could not be confirmed. Retry the same saved operation.'],
  PHOTO_INVALID_IMAGE: [400, 'Choose a valid JPEG, PNG or WebP image of at most 20 megapixels.'],
  PHOTO_TOO_LARGE: [413, 'The photo must be 5 MB or smaller.'],
  PHOTO_UNSUPPORTED_TYPE: [415, 'Only single-frame JPEG, PNG and WebP images are supported.'],
  PHOTO_NOT_FOUND: [404, 'This member has no saved photo.'],
  PHOTO_CHANGED: [409, 'The photo changed. Reload the member before choosing another photo.'],
  PHOTO_OPERATION_PENDING: [409, 'This saved photo operation is still processing. Retry it shortly.'],
  PHOTO_OPERATION_CONFLICT: [409, 'This saved photo operation does not match the original selection.'],
  OWNER_REGISTRATION_STORAGE_UNAVAILABLE: [503, 'Owner registration requires transaction-capable database storage.'],
  DUPLICATE_GYM_NAME: [409, 'A gym with this name already exists. Choose a different name.'],
  IDEMPOTENCY_KEY_CONFLICT: [409, 'This idempotency key was already used with a different request.'],
  ONBOARDING_STORAGE_UNAVAILABLE: [503, 'Combined onboarding requires transaction-capable database storage.'],
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
  RENEWAL_PREVIEW_CHANGED: [409, 'Renewal terms changed. Review the current price and dates before confirming again.'],
  SUBSCRIPTION_ALREADY_RENEWED: [409, 'Subscription already has a direct successor. Renew the latest subscription instead.'],
  SUBSCRIPTION_CANCELLED: [409, 'A cancelled subscription cannot be renewed.'],
  ACTIVE_MEMBERSHIP_EXISTS: [409, 'This member already has an unexpired membership. Wait until its exclusive end date before purchasing or renewing. Payments against existing memberships remain available.'],
  SUBSCRIPTION_OVERLAP: [409, 'Subscription period overlaps an existing non-cancelled subscription.'],
  SUBSCRIPTION_STORAGE_UNAVAILABLE: [503, 'Subscription creation requires transaction-capable database storage.'],
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
    if (error.keyPattern?.gymId && error.keyPattern?.paymentMethod && error.keyPattern?.transactionReference) {
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
