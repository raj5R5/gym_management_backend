const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { hashPassword } = require('../auth/password');
const { createStaff, updateStaff, staffListInput } = require('./staff.validation');
function fail(code) { const error = new Error('Staff operation failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
function dto(user, access) {
  return { userId: String(user._id), email: user.email, displayName: user.displayName ?? null,
    gymId: String(access.gymId), role: access.role, status: access.status };
}
function createStaffService({ UserAccount, GymAccess, Gym, authorizationService, logger }) {
  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId); return current;
  }
  function event(name, auth, gymId, userId, audit = {}) {
    (audit.logger || logger)?.info({ event: name, outcome: 'success', requestId: audit.requestId,
      actorUserId: String(auth.user._id), gymId: String(gymId), userId: String(userId) }, 'Staff security event');
  }
  async function transaction(auth, selected, work) {
    const session = await GymAccess.db.startSession();
    try {
      return await session.withTransaction(async () => {
        // Shared real write prevents write skew across different access records/processes.
        const gym = await Gym.findOneAndUpdate({ _id: selected.gymId, status: 'active' },
          { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).select('_id').lean();
        if (!gym) fail('FORBIDDEN');
        const actor = await GymAccess.findOneAndUpdate({ gymId: selected.gymId, userId: auth.user._id, role: 'admin', status: 'active' },
          { $inc: { __v: 1 } }, { session, timestamps: false, returnDocument: 'after' }).lean();
        if (!actor || !await UserAccount.exists({ _id: auth.user._id, status: 'active' }).session(session)) fail('FORBIDDEN');
        const result = await work(session);
        const admins = await GymAccess.aggregate([{ $match: { gymId: new Types.ObjectId(selected.gymId), role: 'admin', status: 'active' } },
          { $lookup: { from: UserAccount.collection.name, localField: 'userId', foreignField: '_id',
            pipeline: [{ $match: { status: 'active', passwordHash: { $type: 'string', $ne: '' } } }, { $project: { _id: 1 } }], as: 'account' } },
          { $match: { 'account.0': { $exists: true } } }, { $limit: 1 }]).session(session);
        if (!admins.length) fail('LAST_ACTIVE_ADMIN');
        return result;
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('STAFF_STORAGE_UNAVAILABLE');
      throw error;
    } finally { await session.endSession(); }
  }
  async function existing(gymId, userId, session) {
    const access = await GymAccess.findOne({ gymId, userId, role: { $in: ['admin', 'trainer'] } }).session(session ?? null).lean();
    if (!access) fail('STAFF_NOT_FOUND');
    const user = await UserAccount.findById(userId).select('email displayName').session(session ?? null).lean();
    if (!user) fail('STAFF_NOT_FOUND'); return { user, access };
  }
  return {
    async create(auth, authorization, input, audit) {
      const selected = await scope(auth, authorization); const data = parse(createStaff, input);
      // Hash once outside retries; existing identities never have credentials overwritten.
      const passwordHash = await hashPassword(data.password);
      const result = await transaction(auth, selected, async (session) => {
        let user = await UserAccount.findOne({ normalizedEmail: normalizeEmail(data.email) }).session(session).select('email displayName').lean();
        const created = !user;
        if (user && await GymAccess.exists({ userId: user._id, gymId: selected.gymId }).session(session)) fail('DUPLICATE_GYM_ACCESS');
        if (!user) {
          const [record] = await UserAccount.create([{ email: data.email, displayName: data.displayName, passwordHash, status: 'active' }], { session });
          user = record.toObject();
        }
        const [access] = await GymAccess.create([{ userId: user._id, gymId: selected.gymId, role: data.role, status: 'active' }], { session });
        return { data: dto(user, access), created };
      });
      event(result.created ? 'staff.account_created' : 'staff.access_created', auth, selected.gymId, result.data.userId, audit);
      return result.data;
    },
    async get(auth, authorization, userId) {
      const selected = await scope(auth, authorization); const found = await existing(selected.gymId, parse(objectId, userId));
      return dto(found.user, found.access);
    },
    async list(auth, authorization, query) {
      const selected = await scope(auth, authorization); const { page, limit, role, status } = parse(staffListInput, query);
      const [result] = await GymAccess.aggregate([{ $match: { gymId: new Types.ObjectId(selected.gymId), role: role ?? { $in: ['admin', 'trainer'] }, ...(status ? { status } : {}) } },
        { $lookup: { from: UserAccount.collection.name, localField: 'userId', foreignField: '_id',
          pipeline: [{ $project: { email: 1, displayName: 1 } }], as: 'account' } }, { $unwind: '$account' },
        { $facet: { records: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }], count: [{ $count: 'total' }] } }]);
      return { data: result.records.map((record) => dto(record.account, record)), pagination: { page, limit, total: result.count[0]?.total ?? 0 } };
    },
    async update(auth, authorization, userId, input, audit) {
      const selected = await scope(auth, authorization); const id = parse(objectId, userId); const data = parse(updateStaff, input);
      const result = await transaction(auth, selected, async (session) => {
        const before = await existing(selected.gymId, id, session);
        let user = before.user; let access = before.access;
        if (data.displayName !== undefined) user = await UserAccount.findOneAndUpdate({ _id: id }, { $set: { displayName: data.displayName } },
          { session, runValidators: true, returnDocument: 'after' }).select('email displayName').lean();
        const changes = Object.fromEntries(['role', 'status'].filter((field) => data[field] !== undefined).map((field) => [field, data[field]]));
        if (Object.keys(changes).length) access = await GymAccess.findOneAndUpdate({ _id: access._id, gymId: selected.gymId, userId: id },
          { $set: changes }, { session, runValidators: true, returnDocument: 'after' }).lean();
        if (!user || !access) fail('STAFF_NOT_FOUND');
        return { data: dto(user, access), roleChanged: before.access.role !== access.role, statusChanged: before.access.status !== access.status };
      });
      if (result.roleChanged) event('staff.role_changed', auth, selected.gymId, id, audit);
      if (result.statusChanged) event('staff.status_changed', auth, selected.gymId, id, audit);
      return result.data;
    },
  };
}
module.exports = { createStaffService };
