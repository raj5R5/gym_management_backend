const { queueAssets, fail, gymModels, legacyCollections } = require('./automation.scope');

// One transaction: removes the account and its own records, hands off or leaves
// shared gyms, and fences gyms selected for closure. Closure rows are purged after.
async function eraseScope(models, scope, actions, session, now) {
  const userId = scope.user._id;
  const ownerCleanupKeys = [], closedGymIds = [];
  // Serializes competing deletion, profile and staff-ownership transactions.
  const locked = await models.UserAccount.updateOne({ _id: userId, status: 'active', credentialVersion: scope.user.credentialVersion ?? 0 },
    { $inc: { __v: 1 } }, { session, timestamps: false });
  if (!locked.matchedCount) fail('DELETION_SCOPE_CHANGED');
  for (const entry of scope.entries) {
    const { gym, ownProfiles, ownOps } = entry;
    const action = actions.find((a) => String(a.gymId) === String(gym._id));
    await models.Gym.updateOne({ _id: gym._id }, { $inc: { __v: 1 } }, { session, timestamps: false });
    ownerCleanupKeys.push(...await queueAssets(models.OwnerPhotoCleanup, ownProfiles, 'photoPublicId', session, now),
      ...await queueAssets(models.OwnerPhotoCleanup, ownOps, 'publicId', session, now));
    if (action.kind === 'close') {
      // Revoke everyone's access first so no new gym writes start; rows are purged next.
      const fenced = await models.Gym.updateOne({ _id: gym._id, status: 'active' }, { $set: { status: 'inactive' } }, { session });
      if (!fenced.matchedCount) fail('DELETION_SCOPE_CHANGED');
      await models.GymAccess.deleteMany({ gymId: gym._id }, { session });
      closedGymIds.push(gym._id);
      continue;
    }
    if (action.kind === 'transfer') {
      const successor = await models.UserAccount.findOneAndUpdate({ _id: action.successorId, status: 'active',
        credentialVersion: action.acceptedVersion, passwordHash: { $exists: true, $type: 'string', $ne: '' } },
      { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).lean();
      if (!successor) fail('DELETION_SCOPE_CHANGED');
      const promoted = await models.GymAccess.updateOne({ gymId: gym._id, userId: successor._id, status: 'active', role: { $in: ['trainer', 'admin'] } },
        { $set: { role: 'admin' }, $inc: { __v: 1 } }, { session });
      if (!promoted.matchedCount) fail('DELETION_SCOPE_CHANGED');
    }
    const unset = {};
    if (gym.contact?.email?.toLowerCase() === scope.user.email.toLowerCase()) unset['contact.email'] = '';
    if (gym.contact?.phone && ownProfiles.some((p) => p.phone === gym.contact.phone)) unset['contact.phone'] = '';
    if (Object.keys(unset).length) await models.Gym.updateOne({ _id: gym._id }, { $unset: unset }, { session });
    await models.OwnerPhotoOperation.deleteMany({ memberId: { $in: ownProfiles.map((p) => p._id) } }, { session });
    await models.OwnerProfile.deleteMany({ userId, gymId: gym._id }, { session });
  }
  // Gym business records stay with the gym but lose the link to the deleted login.
  // Actor idempotency keys only protect that login's retries, which can no longer occur.
  await models.Payment.collection.updateMany({ recordedByUserId: userId },
    { $unset: { recordedByUserId: '', idempotencyKeyDigest: '', requestDigest: '' } }, { session });
  for (const name of ['MemberProfile', 'TrainerProfile']) {
    await models[name].collection.updateMany({ userId }, { $unset: { userId: '' } }, { session });
  }
  await models.MemberOnboardingOperation.deleteMany({ userId }, { session });
  await models.RenewalOperation.deleteMany({ userId }, { session });
  await models.MemberPhotoOperation.deleteMany({ actorId: userId, state: { $in: ['committed', 'abandoned'] } }, { session });
  await models.GymAccess.deleteMany({ userId }, { session });
  const sessions = await models.AuthSession.find({ userId }).session(session).select('_id').lean();
  await models.RefreshTokenRecord.deleteMany({ sessionId: { $in: sessions.map((s) => s._id) } }, { session });
  await models.AuthSession.deleteMany({ userId }, { session });
  await models.MemberActivation.deleteMany({ userId }, { session });
  await models.PasswordRecovery.deleteMany({ userId }, { session });
  await models.UserAccount.deleteOne({ _id: userId }, { session });
  return { ownerCleanupKeys: [...new Set(ownerCleanupKeys)], memberCleanupKeys: [], closedGymIds };
}

// Idempotent and resumable: each pass queues photo assets before deleting the rows
// that reference them, then deletes the gym only once nothing references it.
async function purgeGym(models, gymId, now) {
  const gym = await models.Gym.findById(gymId).lean();
  if (!gym) return;
  if (gym.status !== 'inactive') fail('DELETION_SCOPE_CHANGED');
  // An upload still in flight could orphan its asset; the photo worker abandons and queues it.
  if (await models.MemberPhotoOperation.exists({ gymId, state: { $in: ['prepared', 'uploading'] } })
    || await models.OwnerPhotoOperation.exists({ gymId, state: { $in: ['prepared', 'uploading'] } })) fail('DELETION_PENDING_OPERATIONS');
  for (const [Model, Queue, field] of [[models.MemberProfile, models.MemberPhotoCleanup, 'photoPublicId'],
    [models.MemberPhotoOperation, models.MemberPhotoCleanup, 'publicId'],
    [models.OwnerProfile, models.OwnerPhotoCleanup, 'photoPublicId'],
    [models.OwnerPhotoOperation, models.OwnerPhotoCleanup, 'publicId']]) {
    for await (const row of Model.find({ gymId, [field]: { $type: 'string' } }).select(`${field} gymId`).lean().cursor()) {
      await queueAssets(Queue, [row], field, undefined, now);
    }
  }
  for (const name of gymModels) await models[name].deleteMany({ gymId });
  const db = models.Gym.db;
  const existing = new Set((await db.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of legacyCollections.filter((n) => existing.has(n))) await db.collection(name).deleteMany({ gymId: gym._id });
  for (const name of gymModels) if (await models[name].exists({ gymId })) fail('DELETION_PURGE_INCOMPLETE');
  await models.Gym.deleteOne({ _id: gymId, status: 'inactive' });
}
module.exports = { eraseScope, purgeGym };
