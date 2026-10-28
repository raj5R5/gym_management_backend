// Internal operator workflow only. Never mount this service on public/app routes.
// Evidence references refer to privately reviewed records, not emails/passwords.
const { createHash } = require('node:crypto');
const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const ref = z.string().min(3).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/);
const retained = ['financial_records', 'membership_transactions', 'minimal_security_audit', 'pseudonymous_account_link'];
const reviewSchema = z.strictObject({ identityRef: ref, retentionRef: ref, ownershipRef: ref, backupRef: ref,
  retainedCategories: z.array(z.strictObject({ category: z.enum(retained),
    purpose: z.string().trim().min(8).max(500), criteria: z.string().trim().min(8).max(500) })).length(4)
    .refine((rows) => new Set(rows.map((row) => row.category)).size === 4) });
const finishSchema = z.strictObject({ notificationRef: ref, offAppRef: ref });
function fail(code) { const error = new Error('Manual deletion requires verified operator review.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('DELETION_REVIEW_INVALID'); return result.data; }
function createDeletionFulfillmentService({ models, enabled = false, reviewer = 'Raj', now = () => new Date() }) {
  const { AccountDeletionRequest, DeletionFulfillment, UserAccount, GymAccess, Gym, OwnerProfile,
    OwnerPhotoOperation, OwnerPhotoCleanup, MemberProfile, TrainerProfile, MemberPhotoOperation,
    AuthSession, RefreshTokenRecord, MemberActivation, PasswordRecovery } = models;
  function authorize(operator) {
    // This argument must come from a trusted operator tool, never an HTTP body.
    if (!enabled || operator !== reviewer) fail('DELETION_REVIEW_FORBIDDEN');
  }
  async function scope(userId, session) {
    const [user, grants, profiles] = await Promise.all([
      UserAccount.findById(userId).session(session ?? null).lean(),
      GymAccess.find({ userId }).session(session ?? null).sort({ _id: 1 }).lean(),
      OwnerProfile.find({ userId }).session(session ?? null).sort({ _id: 1 }).lean(),
    ]);
    if (!user) fail('DELETION_REVIEW_INVALID');
    const scopeDigest = digest(JSON.stringify({ email: user.email, version: user.credentialVersion ?? 0,
      grants: grants.map((g) => [String(g._id), String(g.gymId), g.role, g.status]),
      profiles: profiles.map((p) => [String(p._id), p.photoRevision ?? 0, p.photoPublicId ?? null]) }));
    return { user, grants, profiles, scopeDigest };
  }
  async function transaction(work) {
    const session = await UserAccount.db.startSession();
    try { return await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15000 }); }
    finally { await session.endSession(); }
  }
  return {
    async review(operator, requestId, evidence) {
      authorize(operator); requestId = parse(objectId, requestId); evidence = parse(reviewSchema, evidence);
      return transaction(async (session) => {
        const request = await AccountDeletionRequest.findById(requestId).session(session).lean();
        if (!request || request.status === 'completed') fail('DELETION_REVIEW_INVALID');
        const existing = await DeletionFulfillment.findById(requestId).session(session).lean();
        if (existing && existing.stage !== 'reviewed') fail('DELETION_REVIEW_ALREADY_STARTED');
        const current = await scope(request.userId, session);
        await DeletionFulfillment.updateOne({ _id: requestId }, { $set: { userId: request.userId,
          reviewer, ...evidence, stage: 'reviewed', scopeDigest: current.scopeDigest } }, { upsert: true, session, runValidators: true });
        await AccountDeletionRequest.updateOne({ _id: requestId }, { $set: { status: 'in_review' } }, { session });
        return { stage: 'reviewed' };
      });
    },
    async fulfill(operator, requestId) {
      authorize(operator); requestId = parse(objectId, requestId);
      return transaction(async (session) => {
        const review = await DeletionFulfillment.findById(requestId).session(session).lean();
        if (!review || review.reviewer !== reviewer) fail('DELETION_REVIEW_INVALID');
        if (review.stage !== 'reviewed') return { stage: review.stage }; // Idempotent retry.
        const request = await AccountDeletionRequest.findOne({ _id: requestId, userId: review.userId, status: 'in_review' }).session(session).lean();
        if (!request) fail('DELETION_REVIEW_INVALID');
        // Serialize account/profile changes and existing staff ownership writes.
        await UserAccount.updateOne({ _id: review.userId }, { $inc: { __v: 1 } }, { session, timestamps: false });
        const current = await scope(review.userId, session);
        if (current.scopeDigest !== review.scopeDigest) fail('DELETION_SCOPE_CHANGED');
        if (await MemberProfile.exists({ userId: review.userId }).session(session)
          || await TrainerProfile.exists({ userId: review.userId }).session(session)) fail('DELETION_LINKED_RECORD_REVIEW_REQUIRED');
        const profileIds = current.profiles.map((p) => p._id);
        if (await OwnerPhotoOperation.exists({ memberId: { $in: profileIds }, state: { $in: ['prepared', 'uploading'] } }).session(session)
          || await MemberPhotoOperation.exists({ actorId: review.userId, state: { $in: ['prepared', 'uploading'] } }).session(session)) fail('DELETION_PENDING_OPERATIONS');
        for (const gymId of [...new Set(current.grants.map((g) => String(g.gymId)))].sort()) {
          await Gym.updateOne({ _id: gymId }, { $inc: { __v: 1 } }, { session, timestamps: false });
          if (!current.grants.some((g) => String(g.gymId) === gymId && g.role === 'admin' && g.status === 'active')) continue;
          const others = await GymAccess.find({ gymId, userId: { $ne: review.userId }, role: 'admin', status: 'active' }).session(session).select('userId').lean();
          if (!await UserAccount.exists({ _id: { $in: others.map((g) => g.userId) }, status: 'active',
            passwordHash: { $exists: true, $type: 'string', $ne: '' } }).session(session)) fail('DELETION_OWNERSHIP_HANDOFF_REQUIRED');
        }
        // Include old/abandoned operation assets as well as the current photo.
        // Removing their operation records first would otherwise orphan uploads.
        const oldAssets = await OwnerPhotoOperation.find({ memberId: { $in: profileIds },
          publicId: { $exists: true } }).session(session).select('publicId gymId').lean();
        const assets = new Map([...current.profiles, ...oldAssets]
          .filter((row) => row.photoPublicId || row.publicId)
          .map((row) => [row.photoPublicId ?? row.publicId, row.gymId]));
        const cleanupKeys = [];
        for (const [publicId, gymId] of assets) {
          const key = digest(publicId); cleanupKeys.push(key);
          await OwnerPhotoCleanup.updateOne({ _id: key }, { $setOnInsert: {
            publicId, gymId, after: now() } }, { upsert: true, session });
        }
        await OwnerProfile.updateMany({ userId: review.userId }, { $unset: { phone: '', photoUrl: '', photoPublicId: '' },
          $inc: { photoRevision: 1 } }, { session });
        await OwnerPhotoOperation.deleteMany({ memberId: { $in: profileIds } }, { session });
        await GymAccess.updateMany({ userId: review.userId }, { $set: { status: 'inactive' } }, { session });
        const sessions = await AuthSession.find({ userId: review.userId }).session(session).select('_id').lean();
        await AuthSession.updateMany({ userId: review.userId }, { $set: { status: 'revoked', revokedAt: now() } }, { session });
        await RefreshTokenRecord.updateMany({ sessionId: { $in: sessions.map((s) => s._id) } }, { $set: { revokedAt: now() } }, { session });
        await MemberActivation.deleteMany({ userId: review.userId }, { session });
        await PasswordRecovery.deleteMany({ userId: review.userId }, { session });
        const tombstone = `deleted+${review.userId}@accounts.invalid`;
        await UserAccount.updateOne({ _id: review.userId }, { $set: { status: 'inactive', email: tombstone, normalizedEmail: tombstone },
          $unset: { displayName: '', passwordHash: '' }, $inc: { credentialVersion: 1 } }, { session, runValidators: true });
        await DeletionFulfillment.updateOne({ _id: requestId, stage: 'reviewed' }, { $set: {
          stage: 'cleanup_pending', cleanupKeys, profileIds, fulfilledAt: now() } }, { session });
        // Never alter gyms, members, plans, assignments, memberships, payments or
        // financial/idempotency history as a side effect of deleting an owner.
        return { stage: 'cleanup_pending' };
      });
    },
    async complete(operator, requestId, evidence) {
      authorize(operator); requestId = parse(objectId, requestId); evidence = parse(finishSchema, evidence);
      return transaction(async (session) => {
        const review = await DeletionFulfillment.findById(requestId).session(session).lean();
        if (!review || review.reviewer !== reviewer) fail('DELETION_REVIEW_INVALID');
        if (review.stage === 'completed') return { stage: 'completed' };
        if (review.stage !== 'cleanup_pending') fail('DELETION_REVIEW_INVALID');
        if (await OwnerPhotoCleanup.exists({ _id: { $in: review.cleanupKeys } }).session(session)) fail('DELETION_CLEANUP_PENDING');
        const user = await UserAccount.findById(review.userId).session(session).select('+passwordHash').lean();
        if (!user || user.status !== 'inactive' || user.passwordHash
          || await GymAccess.exists({ userId: review.userId, status: 'active' }).session(session)
          || await OwnerProfile.exists({ userId: review.userId, $or: [{ phone: { $exists: true } }, { photoPublicId: { $exists: true } }] }).session(session)) fail('DELETION_CLEANUP_PENDING');
        await DeletionFulfillment.updateOne({ _id: requestId }, { $set: { ...evidence, stage: 'completed', completedAt: now() } }, { session });
        await AccountDeletionRequest.updateOne({ _id: requestId, userId: review.userId, status: 'in_review' },
          { $set: { status: 'completed' } }, { session });
        return { stage: 'completed' };
      });
    },
  };
}
module.exports = { createDeletionFulfillmentService };
