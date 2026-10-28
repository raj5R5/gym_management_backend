const { randomBytes, createHash } = require('node:crypto');
const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { hashPassword } = require('../auth/password');
const digest = (value) => createHash('sha256').update(value).digest('hex');
function fail(code) { const error = new Error('Account recovery unavailable.'); error.code = code; throw error; }
function createRecoveryService({ UserAccount, AuthSession, RefreshTokenRecord, PasswordRecovery,
  delivery, logger, ttl = 900, now = () => new Date(), hash = hashPassword }) {
  const queue = []; const running = new Set(); let stopped = false;
  async function processJob(job) {
    let tokenId;
    try {
      if (job.kind === 'changed') { await delivery.sendChanged({ email: job.email }); return; }
      const user = await UserAccount.findOne({ normalizedEmail: job.email, status: 'active' }).select('+passwordHash').lean();
      if (!user?.passwordHash) return;
      const token = randomBytes(32).toString('base64url'); tokenId = digest(token);
      await PasswordRecovery.create({ _id: tokenId, userId: user._id,
        emailDigest: digest(normalizeEmail(user.email)), credentialVersion: user.credentialVersion ?? 0,
        expiresAt: new Date(now().getTime() + ttl * 1000) });
      await delivery.sendRecovery({ email: user.email, token, minutes: Math.ceil(ttl / 60) });
    } catch {
      // Never log provider errors, recipients or the raw proof. No successful-
      // delivery claim is made by the generic HTTP acceptance response.
      logger?.warn('Account recovery delivery failed; retry through recovery or support');
      if (tokenId) {
        try { await PasswordRecovery.deleteOne({ _id: tokenId, usedAt: null }); }
        catch { logger?.warn('Recovery proof cleanup deferred until expiry'); }
      }
    }
  }
  function pump() {
    while (queue.length && running.size < 4) {
      const task = processJob(queue.shift()); running.add(task);
      task.finally(() => { running.delete(task); pump(); });
    }
  }
  function enqueue(job) {
    if (stopped || !delivery.configured || queue.length + running.size >= 100) fail('PASSWORD_RECOVERY_UNAVAILABLE');
    queue.push(job); queueMicrotask(pump);
  }
  return {
    request(email) { enqueue({ kind: 'recovery', email: normalizeEmail(email) }); },
    async drain() { while (queue.length || running.size) { pump(); await Promise.all([...running]); } },
    async stop() { stopped = true; queue.length = 0; await Promise.all([...running]); },
    async complete(token, newPassword) {
      try {
      if (!delivery.configured) fail('PASSWORD_RECOVERY_UNAVAILABLE');
      const tokenId = digest(token);
      const proof = await PasswordRecovery.findOne({ _id: tokenId, usedAt: null, expiresAt: { $gt: now() } }).lean();
      if (!proof) fail('INVALID_RECOVERY_CREDENTIAL');
      const passwordHash = await hash(newPassword);
      const session = await UserAccount.db.startSession(); let email;
      try {
        await session.withTransaction(async () => {
          const activeProof = await PasswordRecovery.findOneAndUpdate({ _id: tokenId, usedAt: null,
            expiresAt: { $gt: now() } }, { $set: { usedAt: now() } }, { session, returnDocument: 'after' }).lean();
          if (!activeProof) fail('INVALID_RECOVERY_CREDENTIAL');
          const user = await UserAccount.findById(activeProof.userId).session(session).select('+passwordHash').lean();
          if (!user || user.status !== 'active' || !user.passwordHash
            || (user.credentialVersion ?? 0) !== activeProof.credentialVersion
            || digest(normalizeEmail(user.email)) !== activeProof.emailDigest) fail('INVALID_RECOVERY_CREDENTIAL');
          // Updating the user serializes concurrent resets. Session credential
          // revisions also reject a stale login/refresh racing this transaction.
          const updated = await UserAccount.updateOne({ _id: user._id, passwordHash: user.passwordHash,
            status: 'active', normalizedEmail: normalizeEmail(user.email) },
          { $set: { passwordHash }, $inc: { credentialVersion: 1 } }, { session, runValidators: true });
          if (updated.matchedCount !== 1) fail('INVALID_RECOVERY_CREDENTIAL');
          await AuthSession.updateMany({ userId: user._id }, { $set: { status: 'revoked', revokedAt: now() } }, { session });
          const sessions = await AuthSession.find({ userId: user._id }).session(session).select('_id').lean();
          await RefreshTokenRecord.updateMany({ sessionId: { $in: sessions.map((row) => row._id) } },
            { $set: { revokedAt: now() } }, { session });
          email = user.email;
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 15000 });
      } catch (error) {
        if (error.code === 'INVALID_RECOVERY_CREDENTIAL') throw error;
        fail('PASSWORD_RECOVERY_STORAGE_UNAVAILABLE');
      } finally { await session.endSession(); }
      try { enqueue({ kind: 'changed', email }); }
      catch { logger?.warn('Password change notification unavailable; reset remains committed'); }
      return { passwordChanged: true };
      } catch (error) {
        if (['INVALID_RECOVERY_CREDENTIAL', 'PASSWORD_RECOVERY_UNAVAILABLE', 'PASSWORD_RECOVERY_STORAGE_UNAVAILABLE'].includes(error.code)) throw error;
        fail('PASSWORD_RECOVERY_STORAGE_UNAVAILABLE');
      }
    },
  };
}
module.exports = { createRecoveryService };
