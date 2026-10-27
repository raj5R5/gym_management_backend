function forbidden() { const error = new Error('Member self-service denied.'); error.code = 'FORBIDDEN'; throw error; }
function createSelfMemberResolver({ MemberProfile, authorizationService }) {
  return async function resolveSelfMember(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['member'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['member'], authorization.gymId);
    // Include inactive links in ambiguity detection; never pick one of multiple identities.
    const profiles = await MemberProfile.find({ gymId: current.gymId, userId: auth.user._id })
      .select('gymId memberCode firstName lastName phone status dateOfBirth gender address emergencyContact createdAt updatedAt')
      .limit(2).lean();
    if (profiles.length !== 1 || profiles[0].status !== 'active') forbidden();
    return profiles[0];
  };
}
module.exports = { createSelfMemberResolver };
