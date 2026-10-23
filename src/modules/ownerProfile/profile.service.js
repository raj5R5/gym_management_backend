const { createPhotoService } = require('../memberPhotos/photo.service');
const { photoModels } = require('../memberPhotos/photo.model');
const { fail } = require('../memberPhotos/photo.image');
const { nameKey } = require('../gyms/gym.service');
const { verifyPassword } = require('../auth/password');
function createOwnerProfileService({ OwnerProfile, UserAccount, Gym, authorizationService, storage, logger }) {
  async function access(auth, authorization, profileId) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const scope = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, scope, ['admin'], authorization.gymId);
    let profile = await OwnerProfile.findOne({ userId: scope.userId, gymId: scope.gymId }).lean();
    if (!profile) {
      try { profile = (await OwnerProfile.create({ userId: scope.userId, gymId: scope.gymId })).toObject(); }
      catch (error) {
        if (error.code !== 11000) throw error;
        profile = await OwnerProfile.findOne({ userId: scope.userId, gymId: scope.gymId }).lean();
      }
    }
    if (profileId && String(profile._id) !== String(profileId)) fail('FORBIDDEN');
    return profile;
  }
  const photoFields = (profile) => ({ photoRevision: profile.photoRevision ?? 0,
    ...(profile.photoUrl && profile.photoPublicId
      ? { photoUrl: `gyms/${profile.gymId}/owner-profile/photo?v=${profile.photoRevision ?? 0}` } : {}) });
  const photos = createPhotoService({ MemberProfile: OwnerProfile, ...photoModels(OwnerProfile.db, 'Owner'),
    authorizationService, storage, logger, publicIdPrefix: 'gym_owners', accessOverride: access,
    resultOverride: (profile) => ({ userId: String(profile.userId), gymId: String(profile.gymId), ...photoFields(profile) }) });
  async function get(auth, authorization) {
    const profile = await access(auth, authorization);
    const [user, gym] = await Promise.all([
      UserAccount.findById(profile.userId).lean(), Gym.findById(profile.gymId).lean(),
    ]);
    if (!user || !gym) fail('FORBIDDEN');
    const checks = [Boolean(user.displayName?.trim()), Boolean(user.email), Boolean(profile.phone),
      Boolean(profile.photoUrl && profile.photoPublicId), Boolean(gym.name), Boolean(gym.contact?.phone)];
    return { userId: String(user._id), gymId: String(gym._id), displayName: user.displayName ?? '',
      email: user.email, phone: profile.phone ?? '', gymName: gym.name,
      gymContactPhone: gym.contact?.phone ?? '', gymContactEmail: gym.contact?.email ?? '',
      ...photoFields(profile), completion: { completed: checks.filter(Boolean).length, total: checks.length } };
  }
  async function update(auth, authorization, input) {
    const profile = await access(auth, authorization);
    const user = await UserAccount.findById(profile.userId).select('+passwordHash');
    const emailChanged = user.email.trim().toLowerCase() !== input.email;
    if (emailChanged) {
      if (!input.currentPassword) fail('PROFILE_PASSWORD_REQUIRED');
      if (!await verifyPassword(user.passwordHash, input.currentPassword)) fail('PROFILE_PASSWORD_INVALID');
    }
    const session = await OwnerProfile.db.startSession();
    try {
      await session.withTransaction(async () => {
        await access(auth, authorization, profile._id);
        // Explicit fields only: credentials, role, status, timezone and financial
        // data cannot be changed through profile editing.
        const changed = await UserAccount.updateOne({ _id: profile.userId, status: 'active', email: user.email },
          { $set: { displayName: input.displayName, ...(emailChanged
            ? { email: input.email, normalizedEmail: input.email } : {}) } }, { session, runValidators: true });
        if (changed.matchedCount !== 1) fail('PROFILE_CHANGED');
        await Gym.updateOne({ _id: profile.gymId, status: 'active' }, { $set: {
          name: input.gymName, nameKey: nameKey(input.gymName),
          'contact.phone': input.gymContactPhone, 'contact.email': input.gymContactEmail,
        } }, { session, runValidators: true });
        await OwnerProfile.updateOne({ _id: profile._id, userId: profile.userId, gymId: profile.gymId },
          { $set: { phone: input.phone } }, { session, runValidators: true });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15000 });
    } finally { await session.endSession(); }
    return get(auth, authorization);
  }
  return { access, get, update, photos };
}
module.exports = { createOwnerProfileService };
