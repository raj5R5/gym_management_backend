// Automated account deletion. Disabled unless explicitly enabled with a notice key
// and real adapters; with it disabled the intake-only request flow remains.
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');
const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { digestToken } = require('../auth/tokens');
const { verifyPassword } = require('../auth/password');
const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { getDeletionJobModel } = require('./automation.model');
const { parseChoices, inspectScope, deletionOptions, fail } = require('./automation.scope');
const { eraseScope, purgeGym } = require('./automation.erasure');
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const confirmation = z.strictObject({ token: proof, acknowledgement: z.literal('DELETE_MY_ACCOUNT'),
  closeGymIds: z.array(objectId).max(50) });
const evidence = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/;
// Reasons the requester resolves by reviewing and confirming again (for example after
// an ownership or contact change). They stop before any destructive write.
const blockedReasons = ['DELETION_SCOPE_CHANGED', 'DELETION_OWNERSHIP_HANDOFF_REQUIRED', 'DELETION_OTHER_OWNERS_PRESENT',
  'DELETION_SCOPE_INVALID', 'DELETION_EXISTING_REVIEW_REQUIRED', 'INVALID_AUTHENTICATION'];
function createDeletionAutomation({ models, authService, enabled = false,
  notificationKey, adapters = {}, now = () => new Date() }) {
  if (!enabled) fail('DELETION_AUTOMATION_DISABLED');
  if (!Buffer.isBuffer(notificationKey) || notificationKey.length !== 32) fail('DELETION_KEY_REQUIRED');
  if (['externalStatus', 'notify', 'escalate', 'cleanupPhotos'].some((name) => typeof adapters[name] !== 'function')) fail('DELETION_ADAPTERS_REQUIRED');
  const db = models.UserAccount.db;
  const Job = getDeletionJobModel(db), policyVersion = 'owner-erasure-v2';
  function encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', notificationKey, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decrypt(value) {
    const data = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', notificationKey, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
  async function transaction(work) {
    const session = await db.startSession();
    try { return await session.withTransaction(() => work(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15000 }); }
    finally { await session.endSession(); }
  }
  async function passwordMatches(user, password) {
    return typeof password === 'string' && password.length <= 128 && await verifyPassword(user?.passwordHash, password);
  }
  // App path: a live session plus the current password.
  async function identity(accessToken, password) {
    const auth = await authService.authenticate(accessToken);
    const user = await models.UserAccount.findById(auth.user._id).select('+passwordHash').lean();
    if (!await passwordMatches(user, password)) fail('DELETION_PASSWORD_INVALID');
    return { ...auth, verifiedVersion: user.credentialVersion ?? 0 };
  }
  // Web path: no app session. Same generic error for unknown accounts and wrong passwords.
  async function webIdentity(email, password) {
    const user = await models.UserAccount.findOne({ normalizedEmail: normalizeEmail(email) }).select('+passwordHash').lean();
    if (!await passwordMatches(user, password) || user.status !== 'active') fail('INVALID_CREDENTIALS');
    return { user, session: null, verifiedVersion: user.credentialVersion ?? 0 };
  }
  async function assertSession(auth, session) {
    if (!auth.session) return;
    const held = await models.AuthSession.updateOne({ _id: auth.session._id, userId: auth.user._id,
      status: 'active', expiresAt: { $gt: now() }, idleExpiresAt: { $gt: now() } },
    { $inc: { __v: 1 } }, { session, timestamps: false });
    if (!held.matchedCount) fail('INVALID_AUTHENTICATION');
  }
  const receipt = (job) => ({ id: String(job._id), state: job.state, reason: job.lastReason ?? null,
    completedAt: job.completedAt?.toISOString() ?? null });
  const validId = (id) => { if (!objectId.safeParse(id).success) fail('VALIDATION_ERROR'); return id; };
  const backoff = (attempts) => new Date(now().getTime() + Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000));
  async function leaseUpdate(job, update) {
    const result = await Job.updateOne({ _id: job._id, leaseId: job.leaseId }, update);
    if (!result.matchedCount) fail('DELETION_LEASE_LOST');
  }
  async function preview(auth, actions) {
    const token = randomBytes(32).toString('base64url'), statusToken = randomBytes(32).toString('base64url');
    return transaction(async (session) => {
      await assertSession(auth, session);
      const scope = await inspectScope(models, auth.user._id, actions, session);
      if ((scope.user.credentialVersion ?? 0) !== auth.verifiedVersion) fail('DELETION_SCOPE_CHANGED');
      const existing = await Job.findOne({ userId: auth.user._id }).session(session).lean();
      if (existing && !['preview', 'needs_action'].includes(existing.state)) fail('DELETION_ALREADY_QUEUED');
      // Confirmation lifetime, not retention. A handoff gives the successor a day to accept.
      const minutes = actions.some((a) => a.kind === 'transfer') ? 24 * 60 : 15;
      const expiresAt = new Date(now().getTime() + minutes * 60_000);
      const job = await Job.findOneAndUpdate({ userId: auth.user._id }, { $set: { actions, state: 'preview',
        scopeDigest: scope.digest, policyVersion, credentialVersion: scope.user.credentialVersion ?? 0,
        confirmationDigest: digestToken(token), confirmationExpiresAt: expiresAt,
        statusDigest: digestToken(statusToken), notificationCiphertext: encrypt(scope.user.email),
        nextAttemptAt: now(), attempts: 0, alertPending: false, events: [{ state: 'preview', at: now() }] },
      $unset: { lastReason: '', leaseId: '', leaseUntil: '', confirmedAt: '' } },
      { upsert: true, returnDocument: 'after', runValidators: true, session }).lean();
      return { ...receipt(job), token, statusToken, expiresAt: expiresAt.toISOString(), gyms: scope.plan,
        consequences: 'Delete your login account and its personal data. Signing in and existing sessions stop working. No gym is closed unless you select and confirm its closure.' };
    });
  }
  async function confirm(auth, jobId, input) {
    validId(jobId); const parsed = confirmation.safeParse(input); if (!parsed.success) fail('VALIDATION_ERROR');
    const data = parsed.data;
    return transaction(async (session) => {
      await assertSession(auth, session);
      const job = await Job.findOne({ _id: jobId, userId: auth.user._id, confirmationDigest: digestToken(data.token) })
        .session(session).lean();
      if (!job || job.state === 'needs_action') fail('DELETION_CONFIRMATION_INVALID');
      if (job.confirmedAt) return receipt(job); // Lost-response replay returns one receipt, never another job.
      if (job.state !== 'preview' || job.confirmationExpiresAt <= now()) fail('DELETION_CONFIRMATION_INVALID');
      const closed = job.actions.filter((a) => a.kind === 'close').map((a) => String(a.gymId)).sort();
      if (JSON.stringify(closed) !== JSON.stringify([...data.closeGymIds].sort())) fail('DELETION_CLOSURE_CONFIRMATION_REQUIRED');
      const scope = await inspectScope(models, job.userId, job.actions, session);
      if (scope.digest !== job.scopeDigest || (scope.user.credentialVersion ?? 0) !== job.credentialVersion) fail('DELETION_SCOPE_CHANGED');
      for (const a of job.actions.filter((a) => a.kind === 'transfer')) {
        const successor = await models.UserAccount.findById(a.successorId).session(session).lean();
        if (a.acceptedVersion === undefined || a.acceptedVersion !== (successor?.credentialVersion ?? -1)) fail('DELETION_HANDOFF_ACCEPTANCE_REQUIRED');
      }
      await models.AccountDeletionRequest.findOneAndUpdate({ userId: job.userId },
        { $setOnInsert: { requestedAt: now() }, $set: { status: 'in_review' } }, { upsert: true, session });
      return receipt(await Job.findOneAndUpdate({ _id: job._id, state: 'preview' },
        { $set: { state: 'queued', confirmedAt: now(), nextAttemptAt: now() }, $push: { events: { state: 'queued', at: now() } } },
        { session, returnDocument: 'after' }).lean());
    });
  }
  async function escalate(job, reason, kind) {
    // No operator is invented: the adapter tells the requester and records an alert.
    // Failed delivery leaves a due retry, never a completed receipt.
    try {
      await adapters.escalate({ jobId: String(job._id), reason, kind,
        email: job.notificationCiphertext ? decrypt(job.notificationCiphertext) : null });
      await Job.updateOne({ _id: job._id }, { $set: { alertPending: false } });
    } catch { await Job.updateOne({ _id: job._id }, { $set: { lastReason: 'DELETION_ESCALATION_UNDELIVERED' } }); }
  }
  // Operator path: the requester already verified a request through the app, the web
  // form or a confirmed reply from the account's mailbox. The operator chooses each
  // gym's outcome after reviewing it; nothing is erased until the worker runs.
  async function reviewedRequest(requestId, session) {
    validId(requestId);
    const request = await models.AccountDeletionRequest.findById(requestId).session(session ?? null).lean();
    if (!request || request.status === 'completed') fail('DELETION_REQUEST_NOT_FOUND');
    return request;
  }
  return {
    Job,
    async reviewRequest(requestId) {
      const request = await reviewedRequest(requestId);
      const user = await models.UserAccount.findById(request.userId).select('email displayName status').lean();
      const job = await Job.findOne({ userId: request.userId }).lean();
      return { request: { id: String(request._id), status: request.status, requestedAt: request.requestedAt.toISOString() },
        account: user ? { email: user.email, displayName: user.displayName ?? null, status: user.status } : null,
        gyms: user ? await deletionOptions(models, request.userId) : [], job: job ? receipt(job) : null };
    },
    async planRequest(requestId, choices) {
      const request = await reviewedRequest(requestId), actions = parseChoices(choices);
      if (actions.some((a) => a.kind === 'transfer')) fail('DELETION_SCOPE_INVALID');
      return { gyms: (await inspectScope(models, request.userId, actions)).plan };
    },
    async queueRequest(requestId, choices) {
      const actions = parseChoices(choices);
      // A handoff needs the successor's own acceptance; promote them as staff first, then leave.
      if (actions.some((a) => a.kind === 'transfer')) fail('DELETION_SCOPE_INVALID');
      return transaction(async (session) => {
        const request = await reviewedRequest(requestId, session);
        const scope = await inspectScope(models, request.userId, actions, session);
        const existing = await Job.findOne({ userId: request.userId }).session(session).lean();
        if (existing && !['preview', 'needs_action'].includes(existing.state)) return receipt(existing);
        const job = await Job.findOneAndUpdate({ userId: request.userId }, { $set: { actions, state: 'queued',
          scopeDigest: scope.digest, policyVersion: 'operator-reviewed-v1', credentialVersion: scope.user.credentialVersion ?? 0,
          confirmationDigest: digestToken(randomBytes(32).toString('base64url')), confirmationExpiresAt: now(), confirmedAt: now(),
          statusDigest: digestToken(randomBytes(32).toString('base64url')), notificationCiphertext: encrypt(scope.user.email),
          nextAttemptAt: now(), attempts: 0, alertPending: false, events: [{ state: 'queued', at: now() }] },
        $unset: { lastReason: '', leaseId: '', leaseUntil: '' } },
        { upsert: true, returnDocument: 'after', runValidators: true, session }).lean();
        await models.AccountDeletionRequest.updateOne({ _id: request._id }, { $set: { status: 'in_review' } }, { session });
        return receipt(job);
      });
    },
    async options(accessToken) {
      const auth = await authService.authenticate(accessToken);
      return { gyms: await deletionOptions(models, auth.user._id) };
    },
    async preview(accessToken, password, choices) {
      const actions = parseChoices(choices);
      return preview(await identity(accessToken, password), actions);
    },
    // Web self-service cannot coordinate a handoff, so sole-owned gyms are offered for
    // closure; the requester must still tick each closure before confirming.
    async previewFromWeb(email, password) {
      const auth = await webIdentity(email, password);
      const gyms = await deletionOptions(models, auth.user._id);
      return preview(auth, gyms.map((g) => ({ gymId: g.gymId, kind: g.choices.includes('leave') ? 'leave' : 'close' })));
    },
    async handoffs(accessToken) {
      const auth = await authService.authenticate(accessToken);
      const jobs = await Job.find({ state: 'preview', confirmationExpiresAt: { $gt: now() },
        actions: { $elemMatch: { kind: 'transfer', successorId: auth.user._id } } }).lean();
      const rows = [];
      for (const job of jobs) {
        for (const a of job.actions.filter((a) => a.kind === 'transfer' && String(a.successorId) === String(auth.user._id))) {
          const gym = await models.Gym.findById(a.gymId).select('name').lean();
          rows.push({ jobId: String(job._id), gymId: String(a.gymId), gymName: gym?.name ?? null,
            accepted: a.acceptedVersion !== undefined, expiresAt: job.confirmationExpiresAt.toISOString() });
        }
      }
      return rows;
    },
    async acceptTransfer(accessToken, password, jobId, gymId) {
      validId(jobId); validId(gymId); const auth = await identity(accessToken, password);
      return transaction(async (session) => {
        await assertSession(auth, session);
        const job = await Job.findOne({ _id: jobId, state: 'preview', confirmationExpiresAt: { $gt: now() } }).session(session).lean();
        const action = job?.actions.find((a) => String(a.gymId) === gymId && a.kind === 'transfer' && String(a.successorId) === String(auth.user._id));
        if (!action) fail('FORBIDDEN');
        await inspectScope(models, job.userId, job.actions, session);
        const current = await models.UserAccount.findById(auth.user._id).session(session).lean();
        if (current.status !== 'active' || (current.credentialVersion ?? 0) !== auth.verifiedVersion) fail('DELETION_SCOPE_CHANGED');
        await Job.updateOne({ _id: job._id, state: 'preview', 'actions.gymId': action.gymId },
          { $set: { 'actions.$.acceptedVersion': current.credentialVersion ?? 0 } }, { session });
        return { accepted: true, gymId };
      });
    },
    async confirm(accessToken, jobId, input) {
      return confirm(await authService.authenticate(accessToken), jobId, input);
    },
    async confirmFromWeb(email, password, jobId, input) {
      return confirm(await webIdentity(email, password), jobId, input);
    },
    // Possession of the status proof, returned once at preview, replaces the deleted login.
    async status(jobId, statusToken) {
      validId(jobId); if (!proof.safeParse(statusToken).success) fail('FORBIDDEN');
      const job = await Job.findOne({ _id: jobId, statusDigest: digestToken(statusToken) }).lean();
      if (!job) fail('FORBIDDEN'); return receipt(job);
    },
    async processNext() {
      const leaseId = randomUUID();
      const job = await Job.findOneAndUpdate({ nextAttemptAt: { $lte: now() }, $and: [
        { $or: [{ state: { $in: ['queued', 'purge', 'cleanup', 'notifying'] } }, { state: 'needs_action', alertPending: true }] },
        { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now() } }] }] },
      { $set: { leaseId, leaseUntil: new Date(now().getTime() + 120_000) } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' }).select('+notificationCiphertext').lean();
      if (!job) return false;
      try {
        if (job.state === 'needs_action') {
          await leaseUpdate(job, { $set: { nextAttemptAt: backoff(job.attempts) }, $inc: { attempts: 1 }, $unset: { leaseId: '', leaseUntil: '' } });
          await escalate(job, job.lastReason, 'blocked');
        } else if (job.state === 'queued') {
          await transaction(async (session) => {
            const held = await Job.findOne({ _id: job._id, leaseId, state: 'queued' }).session(session).lean();
            if (!held) fail('DELETION_LEASE_LOST');
            const scope = await inspectScope(models, job.userId, job.actions, session);
            if (scope.digest !== job.scopeDigest) fail('DELETION_SCOPE_CHANGED');
            const cleanup = await eraseScope(models, scope, job.actions, session, now());
            const next = cleanup.closedGymIds.length ? 'purge' : 'cleanup';
            await Job.updateOne({ _id: job._id, leaseId }, { $set: { ...cleanup, state: next, erasedAt: now(), attempts: 0, nextAttemptAt: now() },
              $push: { events: { state: next, at: now() } }, $unset: { leaseId: '', leaseUntil: '', confirmationDigest: '', lastReason: '' } }, { session });
          });
        } else if (job.state === 'purge') {
          for (const gymId of job.closedGymIds) await purgeGym(models, gymId, now());
          await leaseUpdate(job, { $set: { state: 'cleanup', attempts: 0, nextAttemptAt: now() },
            $push: { events: { state: 'cleanup', at: now() } }, $unset: { leaseId: '', leaseUntil: '', lastReason: '' } });
        } else if (job.state === 'cleanup') {
          await adapters.cleanupPhotos();
          const closed = { gymId: { $in: job.closedGymIds } };
          if (await models.OwnerPhotoCleanup.exists({ $or: [{ _id: { $in: job.ownerCleanupKeys } }, closed] })
            || await models.MemberPhotoCleanup.exists({ $or: [{ _id: { $in: job.memberCleanupKeys } }, closed] })) fail('DELETION_PHOTO_CLEANUP_PENDING');
          const external = await adapters.externalStatus({ jobId: String(job._id), userId: String(job.userId), closedGymIds: job.closedGymIds.map(String) });
          if (external?.complete !== true || !evidence.test(external.evidenceRef ?? '')) fail('DELETION_EXTERNAL_CLEANUP_PENDING');
          await leaseUpdate(job, { $set: { state: 'notifying', externalEvidenceRef: external.evidenceRef, attempts: 0, nextAttemptAt: now() },
            $push: { events: { state: 'notifying', at: now() } }, $unset: { leaseId: '', leaseUntil: '', lastReason: '' } });
        } else {
          // Quote the request reference the requester was given at intake, when one exists.
          const intake = await models.AccountDeletionRequest.findOne({ userId: job.userId }).select('_id').lean();
          const notice = await adapters.notify({ email: decrypt(job.notificationCiphertext), jobId: String(job._id),
            reference: String(intake?._id ?? job._id),
            idempotencyKey: `deletion-completed:${job._id}`, kind: 'deletion_completed', closedGyms: job.closedGymIds.length });
          if (!evidence.test(notice?.evidenceRef ?? '')) fail('DELETION_NOTIFICATION_PENDING');
          await transaction(async (session) => {
            const updated = await Job.updateOne({ _id: job._id, leaseId, state: 'notifying' },
              { $set: { state: 'completed', completedAt: now(), notificationRef: notice.evidenceRef },
                $push: { events: { state: 'completed', at: now() } },
                $unset: { leaseId: '', leaseUntil: '', lastReason: '', notificationCiphertext: '' } }, { session });
            if (!updated.matchedCount) fail('DELETION_LEASE_LOST');
            await models.AccountDeletionRequest.updateOne({ userId: job.userId }, { $set: { status: 'completed' } }, { session });
          });
        }
      } catch (error) {
        if (error.code === 'DELETION_LEASE_LOST') return true;
        const reason = /^DELETION_[A-Z_]+$/.test(error.code ?? '') ? error.code
          : error.code === 'INVALID_AUTHENTICATION' ? 'DELETION_SCOPE_CHANGED' : 'DELETION_RETRY_REQUIRED';
        // Only a not-yet-erased job can stop for the requester; after erasure work only retries.
        const blocked = job.state === 'queued' && blockedReasons.includes(reason);
        await leaseUpdate(job, { $set: { lastReason: reason, nextAttemptAt: backoff(job.attempts),
          ...(blocked ? { state: 'needs_action', alertPending: true } : {}) }, $inc: { attempts: 1 }, $unset: { leaseId: '', leaseUntil: '' } });
        if (blocked) await escalate(job, reason, 'blocked');
        else if (job.attempts + 1 === 5) await escalate(job, reason, 'retrying');
      }
      return true;
    },
  };
}
module.exports = { createDeletionAutomation };
