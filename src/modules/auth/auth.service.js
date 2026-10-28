const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { hashPassword, verifyPassword } = require('./password');
const { freshRefreshToken, digestToken, issueAccessToken, verifyAccessToken } = require('./tokens');
function denied(code = 'INVALID_AUTHENTICATION') {
  const error = new Error('Authentication failed.'); error.code = code; return error;
}
function createAuthService({ UserAccount, GymAccess, Gym, AuthSession, RefreshTokenRecord, config, logger }) {
  function securityEvent(event, outcome, audit = {}, { userId, sessionId, reason } = {}) {
    (audit.logger || logger)?.info({ event, outcome, requestId: audit.requestId,
      ...(userId ? { userId: String(userId) } : {}),
      ...(sessionId ? { sessionId: String(sessionId) } : {}), ...(reason ? { reason } : {}),
    }, 'Authentication security event');
  }
  async function revoke(sessionId, audit, reason = 'security') {
    await AuthSession.updateOne({ _id: sessionId }, { $set: { status: 'revoked', revokedAt: new Date() } });
    securityEvent('auth.session_revoked', 'success', audit, { sessionId, reason });
    await RefreshTokenRecord.updateMany({ sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }
  async function identity(user) {
    const grants = await GymAccess.find({ userId: user._id, status: 'active' }).lean();
    const gyms = await Gym.find({ _id: { $in: grants.map((grant) => grant.gymId) }, status: 'active' })
      .select('_id').lean();
    const active = new Set(gyms.map((gym) => String(gym._id)));
    return {
      user: { id: String(user._id), email: user.email, displayName: user.displayName, status: user.status },
      gymAccess: grants.filter((grant) => active.has(String(grant.gymId))).map((grant) => ({
        id: String(grant._id), gymId: String(grant.gymId), role: grant.role, status: grant.status,
      })),
    };
  }
  function credentials(userId, session, raw, expiresAt) {
    return { accessToken: issueAccessToken(userId, session._id, config), refreshToken: raw,
      clientType: session.clientType, refreshExpiresAt: expiresAt,
      expiresIn: config.accessTokenTtl, tokenType: 'Bearer' };
  }
  return {
    async provision(userId, password) {
      const account = await UserAccount.findById(userId).select('+passwordHash');
      if (!account) { const error = new Error('Account not found.'); error.code = 'USER_ACCOUNT_NOT_FOUND'; throw error; }
      if (account.passwordHash) { const error = new Error('Password already provisioned.'); error.code = 'PASSWORD_ALREADY_SET'; throw error; }
      const passwordHash = await hashPassword(password);
      const result = await UserAccount.updateOne({ _id: userId, passwordHash: { $exists: false } }, { $set: { passwordHash } });
      if (!result.modifiedCount) { const error = new Error('Password already provisioned.'); error.code = 'PASSWORD_ALREADY_SET'; throw error; }
      return { passwordProvisioned: true };
    },
    async login({ email, password, client }, audit) {
      const user = await UserAccount.findOne({ normalizedEmail: normalizeEmail(email) }).select('+passwordHash').lean();
      const valid = await verifyPassword(user?.passwordHash, password);
      if (!valid || user?.status !== 'active') {
        securityEvent('auth.login', 'failure', audit);
        throw denied('INVALID_CREDENTIALS');
      }
      const now = new Date();
      const raw = freshRefreshToken();
      const expiresAt = new Date(now.getTime() + config.sessionTtl * 1000);
      const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + config.refreshTokenTtl * 1000));
      const session = await AuthSession.create({ userId: user._id, clientType: client, credentialVersion: user.credentialVersion ?? 0,
        currentTokenHash: digestToken(raw), expiresAt, idleExpiresAt, lastUsedAt: now });
      try {
        await RefreshTokenRecord.create({ sessionId: session._id, tokenHash: digestToken(raw),
          expiresAt: idleExpiresAt, purgeAt: expiresAt });
        const result = { ...await identity(user), ...credentials(user._id, session, raw, idleExpiresAt) };
        securityEvent('auth.login', 'success', audit, { userId: user._id, sessionId: session._id });
        return result;
      } catch (error) { await revoke(session._id, audit, 'operation_failed'); throw error; }
    },
    async refresh(raw, clientType, audit) {
      const now = new Date();
      const hash = digestToken(raw);
      const record = await RefreshTokenRecord.findOne({ tokenHash: hash }).lean();
      if (!record) throw denied();
      const session = await AuthSession.findById(record.sessionId).select('+currentTokenHash').lean();
      if (!session || session.clientType !== clientType) throw denied();
      if (record.usedAt || session.currentTokenHash !== hash) {
        securityEvent('auth.refresh_reuse', 'detected', audit, { sessionId: session._id });
        await revoke(session._id, audit, 'refresh_reuse'); throw denied();
      }
      if (record.revokedAt || record.expiresAt <= now || session.status !== 'active'
        || session.expiresAt <= now || session.idleExpiresAt <= now) throw denied();
      const user = await UserAccount.findById(session.userId).lean();
      if (!user || user.status !== 'active' || (user.credentialVersion ?? 0) !== (session.credentialVersion ?? 0)) { await revoke(session._id, audit, 'account_changed'); throw denied(); }
      const replacement = freshRefreshToken();
      const replacementHash = digestToken(replacement);
      const expiresAt = new Date(Math.min(session.expiresAt.getTime(), now.getTime() + config.refreshTokenTtl * 1000));
      // Session CAS is the atomic authority. Persist replacement first so crashes fail closed.
      const next = await RefreshTokenRecord.create({ sessionId: session._id, tokenHash: replacementHash,
        expiresAt, purgeAt: session.expiresAt });
      try {
        const rotated = await AuthSession.updateOne({ _id: session._id, status: 'active',
          currentTokenHash: hash, expiresAt: { $gt: now }, idleExpiresAt: { $gt: now } },
        { $set: { currentTokenHash: replacementHash, idleExpiresAt: expiresAt, lastUsedAt: now } });
        if (!rotated.modifiedCount) {
          securityEvent('auth.refresh_reuse', 'detected', audit, { sessionId: session._id });
          await revoke(session._id, audit, 'refresh_conflict'); throw denied();
        }
        await RefreshTokenRecord.updateOne({ _id: record._id }, { $set: { usedAt: now, replacedBy: next._id } });
        return credentials(user._id, session, replacement, expiresAt);
      } catch (error) { await revoke(session._id, audit, 'operation_failed'); throw error; }
    },
    async authenticate(token) {
      let claims;
      try { claims = verifyAccessToken(token, config); } catch { throw denied(); }
      const now = new Date();
      const session = await AuthSession.findOne({ _id: claims.sid, userId: claims.sub,
        status: 'active', expiresAt: { $gt: now }, idleExpiresAt: { $gt: now } }).lean();
      const user = session && await UserAccount.findById(claims.sub).lean();
      if (!user || user.status !== 'active' || (user.credentialVersion ?? 0) !== (session.credentialVersion ?? 0)) throw denied();
      return { user, session };
    },
    async me(context) { return identity(context.user); },
    async logoutCredentials({ bearer, raw, clientType, trustedWebOrigin }, audit) {
      const sessions = new Map();
      // Verify every supplied credential before mutating any session. Refresh is
      // sufficient when access has expired; conflicting verified sessions are both revoked.
      if (raw) {
        const record = await RefreshTokenRecord.findOne({ tokenHash: digestToken(raw) }).lean();
        const session = record && await AuthSession.findById(record.sessionId).lean();
        if (!session || session.clientType !== clientType) throw denied();
        sessions.set(String(session._id), session);
      }
      if (bearer) {
        let claims;
        try { claims = verifyAccessToken(bearer, config, { allowExpired: true }); }
        catch { throw denied(); }
        const session = await AuthSession.findOne({ _id: claims.sid, userId: claims.sub }).lean();
        if (!session) throw denied();
        sessions.set(String(session._id), session);
      }
      if (!sessions.size) throw denied();
      if ([...sessions.values()].some((session) => session.clientType === 'web') && !trustedWebOrigin) {
        const error = new Error('Origin not allowed.'); error.code = 'CORS_ORIGIN_DENIED'; throw error;
      }
      for (const session of sessions.values()) {
        await revoke(session._id, audit, 'logout');
        securityEvent('auth.logout', 'success', audit, { sessionId: session._id });
      }
    },
  };
}
module.exports = { createAuthService };
