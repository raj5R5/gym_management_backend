const { randomBytes, createHash } = require('node:crypto');
const { objectId } = require('../gyms/gym.validation');
const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { hashPassword } = require('../auth/password');
const schemas = require('./account.validation');
const ACTIVATION_TTL_MS = 15 * 60 * 1000;
function fail(code) { const error = new Error('Member account operation failed.'); error.code = code; throw error; }
function parse(schema, input) { const result = schema.safeParse(input); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function digest(token) { return createHash('sha256').update(token).digest('hex'); }
function dto(user, access) {
  return { provisioned: Boolean(access), ...(user ? { userId: String(user._id), email: user.email } : {}),
    gymAccess: access ? { role: access.role, status: access.status } : null, activated: Boolean(user?.passwordHash) };
}
function createMemberAccountService({ MemberProfile, UserAccount, GymAccess, Gym, MemberActivation, authorizationService, logger }) {
  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const selected = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, selected, ['admin'], authorization.gymId); return selected;
  }
  async function transaction(work) {
    const session = await MemberProfile.db.startSession();
    try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
    catch (error) { if (error.code === 20 || error.originalError?.code === 20) fail('MEMBER_ACCOUNT_STORAGE_UNAVAILABLE'); throw error; }
    finally { await session.endSession(); }
  }
  function event(name, gymId, memberId, userId, audit = {}, actorUserId) {
    (audit.logger || logger)?.info({ event: name, outcome: 'success', requestId: audit.requestId,
      gymId: String(gymId), memberId: String(memberId), userId: String(userId),
      ...(actorUserId ? { actorUserId: String(actorUserId) } : {}) }, 'Member account security event');
  }
  async function lockGym(gymId, session, code = 'FORBIDDEN') {
    const gym = await Gym.findOneAndUpdate({ _id: gymId, status: 'active' }, { $inc: { __v: 1 } },
      { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
    if (!gym) fail(code);
  }
  async function lockAdmin(auth, selected, session) {
    await lockGym(selected.gymId, session);
    const actor = await GymAccess.findOneAndUpdate({ userId: auth.user._id, gymId: selected.gymId, role: 'admin', status: 'active' },
      { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).lean();
    if (!actor || !await UserAccount.exists({ _id: auth.user._id, status: 'active' }).session(session)) fail('FORBIDDEN');
  }
  async function member(gymId, memberId, session, lock = false) {
    const id = parse(objectId, memberId);
    const query = lock ? MemberProfile.findOneAndUpdate({ _id: id, gymId }, { $inc: { __v: 1 } },
      { session, timestamps: false, returnDocument: 'after' }) : MemberProfile.findOne({ _id: id, gymId }).session(session ?? null);
    const record = await query.select('_id userId status').lean(); if (!record) fail('MEMBER_NOT_FOUND'); return record;
  }
  async function linked(gymId, record, session) {
    if (!record.userId) return { user: null, access: null };
    const user = await UserAccount.findById(record.userId).select('email +passwordHash status').session(session ?? null).lean();
    if (!user) fail('INVALID_MEMBER_ACCOUNT_STATE');
    const access = await GymAccess.findOne({ gymId, userId: record.userId }).session(session ?? null).lean();
    if (access && access.role !== 'member') fail('MEMBER_ACCOUNT_IDENTITY_CONFLICT');
    return { user, access };
  }
  return {
    async get(auth, authorization, memberId) {
      const selected = await scope(auth, authorization); const record = await member(selected.gymId, memberId);
      const found = await linked(selected.gymId, record); return dto(found.user, found.access);
    },
    async provision(auth, authorization, memberId, input, audit) {
      const selected = await scope(auth, authorization); const data = parse(schemas.provision, input);
      const activationToken = randomBytes(32).toString('base64url'); const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS);
      const result = await transaction(async (session) => {
        await lockAdmin(auth, selected, session);
        const record = await member(selected.gymId, memberId, session, true);
        if (record.status !== 'active') fail('FORBIDDEN');
        let user = await UserAccount.findOne({ normalizedEmail: normalizeEmail(data.email) }).select('email displayName status +passwordHash').session(session).lean();
        if (record.userId && (!user || String(record.userId) !== String(user._id))) fail('MEMBER_ACCOUNT_IDENTITY_CONFLICT');
        if (user && (!record.userId || String(record.userId) !== String(user._id))) fail('MEMBER_ACCOUNT_IDENTITY_CONFLICT');
        if (user && user.status !== 'active') fail('FORBIDDEN');
        if (user && await MemberProfile.exists({ gymId: selected.gymId, userId: user._id, _id: { $ne: record._id } }).session(session)) fail('MEMBER_ACCOUNT_IDENTITY_CONFLICT');
        if (user && await GymAccess.exists({ userId: user._id, gymId: selected.gymId }).session(session)) fail('MEMBER_ACCOUNT_ALREADY_PROVISIONED');
        if (!user) {
          const [created] = await UserAccount.create([{ email: data.email, displayName: data.displayName, status: 'active' }], { session }); user = created.toObject();
          // Trusted set-once identity link; the conditional write cannot replace an existing link.
          const link = await MemberProfile.updateOne({ _id: record._id, gymId: selected.gymId, userId: null },
            { $set: { userId: user._id } }, { session, runValidators: true, overwriteImmutable: true });
          if (link.modifiedCount !== 1) fail('MEMBER_ACCOUNT_IDENTITY_CONFLICT');
        }
        const [access] = await GymAccess.create([{ userId: user._id, gymId: selected.gymId, role: 'member', status: 'active' }], { session });
        if (!user.passwordHash) await MemberActivation.create([{ tokenDigest: digest(activationToken), userId: user._id,
          gymId: selected.gymId, memberId: record._id, expiresAt }], { session });
        return { data: dto(user, access), ...(user.passwordHash ? {} : { activationToken, activationExpiresAt: expiresAt }) };
      });
      event('member.account_provisioned', selected.gymId, memberId, result.data.userId, audit, auth.user._id);
      return result;
    },
    async revoke(auth, authorization, memberId, audit) {
      const selected = await scope(auth, authorization);
      const result = await transaction(async (session) => {
        await lockAdmin(auth, selected, session); const record = await member(selected.gymId, memberId, session, true);
        const found = await linked(selected.gymId, record, session);
        if (!found.access) fail('MEMBER_ACCOUNT_NOT_PROVISIONED');
        const access = await GymAccess.findOneAndUpdate({ _id: found.access._id, userId: record.userId, gymId: selected.gymId, role: 'member' },
          { $set: { status: 'inactive' } }, { session, runValidators: true, returnDocument: 'after' }).lean();
        if (!access) fail('MEMBER_ACCOUNT_NOT_PROVISIONED');
        await MemberActivation.updateMany({ userId: record.userId, gymId: selected.gymId, memberId: record._id, usedAt: null },
          { $set: { usedAt: new Date() } }, { session });
        return dto(found.user, access);
      });
      event('member.gym_access_revoked', selected.gymId, memberId, result.userId, audit, auth.user._id); return result;
    },
    async activate(input, audit) {
      const data = parse(schemas.activate, input); const tokenDigest = digest(data.token);
      const eligible = { tokenDigest, usedAt: null, expiresAt: { $gt: new Date() } };
      if (!await MemberActivation.exists(eligible)) fail('INVALID_ACTIVATION_CREDENTIAL');
      // Existing Argon2id policy/tool; expensive hashing is outside transaction retries.
      const passwordHash = await hashPassword(data.password);
      const result = await transaction(async (session) => {
        const now = new Date();
        const credential = await MemberActivation.findOneAndUpdate({ tokenDigest, usedAt: null, expiresAt: { $gt: now } },
          { $set: { usedAt: now } }, { session, returnDocument: 'after', runValidators: true }).lean();
        if (!credential) fail('INVALID_ACTIVATION_CREDENTIAL');
        await lockGym(credential.gymId, session, 'INVALID_ACTIVATION_CREDENTIAL');
        const record = await MemberProfile.findOneAndUpdate({ _id: credential.memberId, gymId: credential.gymId,
          userId: credential.userId, status: 'active' }, { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
        const access = await GymAccess.findOneAndUpdate({ gymId: credential.gymId, userId: credential.userId, role: 'member', status: 'active' },
          { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
        if (!record || !access) fail('INVALID_ACTIVATION_CREDENTIAL');
        const user = await UserAccount.findOneAndUpdate({ _id: credential.userId, status: 'active', passwordHash: { $exists: false } },
          { $set: { passwordHash } }, { session, runValidators: true, returnDocument: 'after' }).select('_id').lean();
        if (!user) fail('INVALID_ACTIVATION_CREDENTIAL');
        return credential;
      });
      event('member.account_activated', result.gymId, result.memberId, result.userId, audit);
      return { activated: true };
    },
  };
}
module.exports = { createMemberAccountService };
