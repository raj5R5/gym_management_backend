const { objectId } = require('../gyms/gym.validation');
const { createMember, onboardMember, updateMember, memberListQuery } = require('./member.validation');
function fail(code) { const error = new Error('Member operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('VALIDATION_ERROR');
  return result.data;
}
function memberDto(member) {
  return { id: String(member._id), gymId: String(member.gymId), userId: member.userId ? String(member.userId) : undefined,
    branchId: member.branchId ? String(member.branchId) : undefined, memberCode: member.memberCode,
    firstName: member.firstName, lastName: member.lastName, phone: member.phone,
    dateOfBirth: member.dateOfBirth ? member.dateOfBirth.toISOString().slice(0, 10) : undefined,
    gender: member.gender, address: member.address, emergencyContact: member.emergencyContact,
    status: member.status, createdAt: member.createdAt, updatedAt: member.updatedAt };
}
function createMemberService({ MemberProfile, Branch, UserAccount, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    // Re-resolve server-side access for service callers, never trust a body tenant/role.
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    return current.gymId;
  }
  async function activeBranch(gymId, branchId, session) {
    if (!branchId) return;
    const branch = await Branch.findOne({ _id: branchId, gymId }).session(session ?? null).select('status').lean();
    if (!branch) fail('BRANCH_NOT_FOUND');
    if (branch.status !== 'active') fail('FORBIDDEN');
  }
  async function existing(gymId, memberId) {
    const id = parse(objectId, memberId);
    const member = await MemberProfile.findOne({ _id: id, gymId }).lean();
    if (!member) fail('MEMBER_NOT_FOUND');
    return member;
  }
  async function insert(gymId, data, userId, session) {
    const record = { ...data, gymId, ...(userId ? { userId } : {}) };
    for (const key of Object.keys(record)) if (record[key] === null) delete record[key];
    const created = session ? (await MemberProfile.create([record], { session }))[0] : await MemberProfile.create(record);
    return memberDto(created.toObject());
  }
  return {
    async onboardForComplete(auth, authorization, input, session) {
      if (!session?.inTransaction() || session.client !== MemberProfile.db.getClient()) fail('INVALID_TRANSACTION_CONTEXT');
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(onboardMember, input);
      await activeBranch(gymId, data.branchId, session);
      return insert(gymId, { ...data, status: 'active' }, undefined, session);
    },
    async onboard(auth, authorization, input) {
      const gymId = await scope(auth, authorization, ['admin', 'trainer']);
      const data = parse(onboardMember, input);
      await activeBranch(gymId, data.branchId);
      return insert(gymId, { ...data, status: 'active' });
    },
    async create(auth, authorization, input, { linkedUserId } = {}) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(createMember, input);
      await activeBranch(gymId, data.branchId);
      // Reserved for trusted server callers; HTTP bodies cannot set this relationship.
      const userId = linkedUserId === undefined ? undefined : parse(objectId, linkedUserId);
      if (userId && !await UserAccount.exists({ _id: userId })) fail('USER_ACCOUNT_NOT_FOUND');
      return insert(gymId, data, userId);
    },
    async get(auth, authorization, memberId) {
      const gymId = await scope(auth, authorization, ['admin', 'trainer']);
      return memberDto(await existing(gymId, memberId));
    },
    async list(auth, authorization, query) {
      const gymId = await scope(auth, authorization, ['admin', 'trainer']);
      const { page, limit, status, search } = parse(memberListQuery, query);
      const filter = { gymId, ...(status ? { status } : {}) };
      if (search) {
        const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = ['memberCode', 'firstName', 'lastName', 'phone'].map((field) =>
          ({ [field]: { $regex: literal, $options: 'i' } }));
      }
      const [records, total] = await Promise.all([
        MemberProfile.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        MemberProfile.countDocuments(filter),
      ]);
      return { data: records.map(memberDto), pagination: { page, limit, total } };
    },
    async update(auth, authorization, memberId, input) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(updateMember, input);
      await existing(gymId, memberId);
      await activeBranch(gymId, data.branchId);
      const set = {}, unset = {};
      for (const [key, value] of Object.entries(data)) {
        if (value === null) unset[key] = ''; else set[key] = value;
      }
      const member = await MemberProfile.findOneAndUpdate({ _id: memberId, gymId },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!member) fail('MEMBER_NOT_FOUND');
      return memberDto(member);
    },
  };
}
module.exports = { createMemberService };
