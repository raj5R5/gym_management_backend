const { createHash, randomUUID } = require('node:crypto');
const { objectId } = require('../gyms/gym.validation');
const { preparePhoto, fail } = require('./photo.image');
const { photoFields } = require('./photo.dto');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digestOf = (value) => createHash('sha256').update(value).digest('hex');
const leaseMs = 5 * 60_000;
const retentionMs = 24 * 60 * 60_000;
function createPhotoService({ MemberProfile, PhotoOperation, PhotoCleanup, authorizationService,
  storage, logger, now = () => new Date(), accessOverride, resultOverride, publicIdPrefix = 'gym_members' }) {
  async function access(auth, authorization, memberId, write = false) {
    if (accessOverride) return accessOverride(auth, authorization, memberId, write);
    const allowed = write ? ['admin'] : ['admin', 'trainer'];
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    if (!objectId.safeParse(memberId).success) fail('VALIDATION_ERROR');
    const member = await MemberProfile.findOne({ _id: memberId, gymId: current.gymId }).lean();
    if (!member) fail('MEMBER_NOT_FOUND');
    return member;
  }
  const result = resultOverride ?? ((member) => ({ memberId: String(member._id), ...photoFields(member), photoRevision: member.photoRevision ?? 0 }));
  async function enqueue(publicId, gymId, session, after = now()) {
    if (!publicId) return;
    await PhotoCleanup.updateOne({ _id: digestOf(publicId) }, { $setOnInsert: { publicId, gymId, after } },
      { upsert: true, ...(session ? { session } : {}) });
  }
  async function mutate(auth, authorization, memberId, operationKey, kind, file) {
    let member = await access(auth, authorization, memberId, true);
    memberId = String(member._id);
    if (!uuid.test(operationKey ?? '')) fail('VALIDATION_ERROR');
    if (kind === 'upload' && !storage.configured) fail('PHOTO_STORAGE_UNAVAILABLE');
    const bytes = kind === 'upload' ? await preparePhoto(file) : null;
    const digest = digestOf(kind === 'upload' ? file.buffer : 'remove');
    const id = digestOf(`${member.gymId}:${memberId}:${operationKey}`);
    let operation = await PhotoOperation.findById(id).lean();
    if (!operation) {
      try {
        operation = (await PhotoOperation.create({ _id: id, gymId: member.gymId, memberId,
          actorId: auth.user._id, kind, digest, baseRevision: member.photoRevision ?? 0, state: 'prepared',
          ...(kind === 'upload' ? { publicId: `${publicIdPrefix}/${member.gymId}/${memberId}/${operationKey}` } : {}) })).toObject();
      } catch (error) {
        if (error.code !== 11000) throw error;
        operation = await PhotoOperation.findById(id).lean();
      }
    }
    if (operation.digest !== digest || operation.kind !== kind || String(operation.actorId) !== String(auth.user._id)) fail('PHOTO_OPERATION_CONFLICT');
    if (operation.state === 'committed') return result(await access(auth, authorization, memberId, true));
    if (operation.state === 'abandoned' || operation.baseRevision !== (member.photoRevision ?? 0)) fail('PHOTO_CHANGED');
    const leaseId = randomUUID();
    const owned = await PhotoOperation.findOneAndUpdate({ _id: id, $or: [{ state: 'prepared' },
      { state: 'uploading', leaseUntil: { $lt: now() } }] },
    { $set: { state: 'uploading', leaseId, leaseUntil: new Date(now().getTime() + leaseMs) } }, { returnDocument: 'after' }).lean();
    if (!owned) fail('PHOTO_OPERATION_PENDING');
    let uploaded;
    try {
      if (bytes) {
        try { uploaded = await storage.upload(bytes, operation.publicId); }
        catch { fail('PHOTO_STORAGE_UNAVAILABLE'); }
      }
      member = await access(auth, authorization, memberId, true);
      const previousPublicId = member.photoPublicId;
      const session = await MemberProfile.db.startSession();
      try {
        await session.withTransaction(async () => {
          // Ownership of the operation and the member revision are committed
          // together. Cleanup cannot race an expired upload into a live record.
          const claim = await PhotoOperation.updateOne({ _id: id, state: 'uploading', leaseId },
            { $set: { state: 'committed' }, $unset: { leaseId: '', leaseUntil: '' } }, { session });
          if (claim.modifiedCount !== 1) fail('PHOTO_CHANGED');
          const revision = operation.baseRevision;
          const updated = await MemberProfile.findOneAndUpdate({ _id: memberId, gymId: member.gymId,
            ...(revision === 0 ? { $or: [{ photoRevision: 0 }, { photoRevision: { $exists: false } }] }
              : { photoRevision: revision }) },
          { $inc: { photoRevision: 1 }, ...(uploaded ? { $set: { photoUrl: uploaded.url, photoPublicId: uploaded.publicId } }
            : { $unset: { photoUrl: '', photoPublicId: '' } }) }, { session, returnDocument: 'after', runValidators: true }).lean();
          if (!updated) fail('PHOTO_CHANGED');
          await enqueue(previousPublicId, member.gymId, session);
          member = updated;
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15_000 });
      } finally { await session.endSession(); }
      return result(member);
    } catch (error) {
      // Never compensate by deleting a possibly committed asset. The durable
      // operation and cleanup worker reconcile uncertainty against MongoDB.
      try {
        const actual = await PhotoOperation.findById(id).lean();
        if (actual?.state === 'committed') return result(await access(auth, authorization, memberId, true));
        await PhotoOperation.updateOne({ _id: id, state: 'uploading', leaseId },
          { $set: { state: 'prepared', leaseUntil: new Date(now().getTime() + retentionMs) }, $unset: { leaseId: '' } });
      } catch { /* Durable staged record remains available to reconciliation. */ }
      if (error.code?.startsWith('PHOTO_') || ['FORBIDDEN', 'MEMBER_NOT_FOUND'].includes(error.code)) throw error;
      fail('PHOTO_DATABASE_UNAVAILABLE');
    }
  }
  let timer; let running;
  async function cleanup() {
    if (!storage.configured) return;
    const expired = await PhotoOperation.find({ state: { $in: ['prepared', 'uploading', 'abandoned'] },
      updatedAt: { $lt: new Date(now().getTime() - retentionMs) } }).limit(25).lean();
    for (const op of expired) {
      const claimed = await PhotoOperation.findOneAndUpdate({ _id: op._id, state: op.state,
        updatedAt: op.updatedAt }, { $set: { state: 'abandoned' }, $unset: { leaseId: '', leaseUntil: '' } }, { returnDocument: 'after' }).lean();
      if (claimed) await enqueue(claimed.publicId, claimed.gymId, null);
    }
    const due = await PhotoCleanup.find({ after: { $lte: now() } }).limit(25).lean();
    for (const item of due) {
      try {
        // An unknown database outcome must never delete a currently referenced
        // asset. Unavailable database reads leave the cleanup record untouched.
        if (await MemberProfile.exists({ photoPublicId: item.publicId })) continue;
        await storage.destroy(item.publicId);
        await PhotoCleanup.deleteOne({ _id: item._id });
      } catch {
        await PhotoCleanup.updateOne({ _id: item._id }, { $inc: { attempts: 1 },
          $set: { after: new Date(now().getTime() + 5 * 60_000) } });
        logger?.warn('Member photo cleanup deferred; durable retry retained');
      }
    }
  }
  return {
    access,
    upload: (auth, authorization, memberId, key, file) => mutate(auth, authorization, memberId, key, 'upload', file),
    remove: (auth, authorization, memberId, key) => mutate(auth, authorization, memberId, key, 'remove'),
    async status(auth, authorization, memberId, key) {
      const member = await access(auth, authorization, memberId, true);
      if (!uuid.test(key ?? '')) fail('VALIDATION_ERROR');
      const id = digestOf(`${member.gymId}:${member._id}:${key}`);
      const operation = await PhotoOperation.findById(id).lean();
      if (operation && String(operation.actorId) !== String(auth.user._id)) fail('FORBIDDEN');
      return { ...result(member), state: operation?.state ?? 'unknown' };
    },
    async read(auth, authorization, memberId) {
      const member = await access(auth, authorization, memberId);
      if (!member.photoUrl || !member.photoPublicId) fail('PHOTO_NOT_FOUND');
      return storage.read(member.photoPublicId);
    },
    cleanup,
    startCleanup() {
      if (timer || !storage.configured) return;
      const run = () => {
        if (running) return;
        running = cleanup().catch(() => logger?.warn('Member photo cleanup deferred')).finally(() => { running = null; });
      };
      timer = setInterval(run, 60_000); timer.unref(); run();
    },
    async stopCleanup() { clearInterval(timer); timer = null; await running; },
  };
}
module.exports = { createPhotoService };
