const { objectId } = require('../gyms/gym.validation');
const { roles } = require('../gymAccess/gymAccess.validation');

function failure(code) {
  const error = new Error(code === 'INVALID_AUTHENTICATION' ? 'Authentication required.' : 'Access denied.');
  error.code = code;
  return error;
}

function identifier(value) {
  const parsed = objectId.safeParse(value);
  if (!parsed.success) throw failure('VALIDATION_ERROR');
  return parsed.data.toLowerCase();
}

function authenticatedUser(auth) {
  const now = new Date();
  if (!auth?.user?._id || auth.user.status !== 'active' || !auth.session?._id
    || auth.session.status !== 'active' || String(auth.session.userId) !== String(auth.user._id)
    || !(auth.session.expiresAt > now) || !(auth.session.idleExpiresAt > now)) {
    throw failure('INVALID_AUTHENTICATION');
  }
  return String(auth.user._id);
}

function requireScope(auth, authorization) {
  const userId = authenticatedUser(auth);
  const validIds = authorization && ['userId', 'gymId', 'gymAccessId'].every((field) => {
    const parsed = objectId.safeParse(authorization[field]);
    return parsed.success && parsed.data === parsed.data.toLowerCase();
  });
  if (!validIds || authorization.userId !== userId || !roles.includes(authorization.role)) {
    throw failure('FORBIDDEN');
  }
  return authorization;
}

function createAuthorizationService({ GymAccess, Gym }) {
  return {
    async requireGymAccess(auth, gymId) {
      const userId = authenticatedUser(auth);
      const selectedGymId = identifier(gymId);
      // The URL selects a requested scope. Only persisted access grants authority.
      const access = await GymAccess.findOne({ userId, gymId: selectedGymId, status: 'active' })
        .select('_id userId gymId role').lean();
      if (!access || !roles.includes(access.role)) throw failure('FORBIDDEN');
      const gym = await Gym.findOne({ _id: selectedGymId, status: 'active' }).select('_id').lean();
      // Missing/inactive/unrelated gyms produce the same denial, avoiding a lookup oracle.
      if (!gym) throw failure('FORBIDDEN');
      return Object.freeze({ userId, gymId: String(gym._id), gymAccessId: String(access._id), role: access.role });
    },
    requireRoles(auth, authorization, allowedRoles, gymId) {
      const scope = requireScope(auth, authorization);
      const selectedGym = objectId.safeParse(gymId);
      if (!selectedGym.success || scope.gymId !== selectedGym.data.toLowerCase()) throw failure('FORBIDDEN');
      if (!allowedRoles.includes(scope.role)) throw failure('FORBIDDEN');
    },
  };
}

module.exports = { createAuthorizationService };
