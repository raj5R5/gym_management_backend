const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { createAssignment, updateAssignment, assignmentListInput, scopedInput } = require('./assignment.validation');
function fail(code) { const error = new Error('Assignment operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('VALIDATION_ERROR');
  return result.data;
}
function dto(record) {
  return { id: String(record._id), gymId: String(record.gymId), trainerId: String(record.trainerId),
    memberId: String(record.memberId), status: record.status, assignedAt: record.assignedAt,
    endedAt: record.endedAt, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
function createAssignmentService({ TrainerMemberAssignment, TrainerProfile, MemberProfile, Branch, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    return current;
  }
  async function selfTrainer(auth, gymId) {
    // No client trainerId grants ownership. Ambiguous existing links fail closed.
    const profiles = await TrainerProfile.find({ userId: auth.user._id, gymId, status: 'active' })
      .select('_id').limit(2).lean();
    if (profiles.length !== 1) fail('FORBIDDEN');
    return String(profiles[0]._id);
  }
  async function readScope(auth, authorization) {
    const current = await scope(auth, authorization, ['admin', 'trainer']);
    return { gymId: current.gymId, ...(current.role === 'trainer'
      ? { trainerId: await selfTrainer(auth, current.gymId) } : {}) };
  }
  async function profiles(gymId, trainerId, memberId, active = false) {
    const trainer = await TrainerProfile.findOne({ _id: trainerId, gymId }).select('_id status').lean();
    if (!trainer) fail('TRAINER_NOT_FOUND');
    const member = await MemberProfile.findOne({ _id: memberId, gymId }).select('_id status').lean();
    if (!member) fail('MEMBER_NOT_FOUND');
    if (active && (trainer.status !== 'active' || member.status !== 'active')) fail('FORBIDDEN');
  }
  async function existing(filter, assignmentId) {
    const record = await TrainerMemberAssignment.findOne({ ...filter, _id: parse(objectId, assignmentId) }).lean();
    if (!record) fail('ASSIGNMENT_NOT_FOUND');
    // Verify reference tenancy on reads too, even for inconsistent legacy/raw records.
    await profiles(filter.gymId, record.trainerId, record.memberId);
    return record;
  }
  async function view(auth, authorization, id, query, direction) {
    const selected = await readScope(auth, authorization); const profileId = parse(objectId, id);
    const { page, limit, status } = parse(scopedInput, query);
    if (selected.trainerId && status !== 'active') fail('FORBIDDEN');
    if (direction === 'trainer' && selected.trainerId && selected.trainerId !== profileId.toLowerCase()) fail('FORBIDDEN');
    const model = direction === 'trainer' ? TrainerProfile : MemberProfile;
    if (!await model.exists({ _id: profileId, gymId: selected.gymId })) fail(direction === 'trainer' ? 'TRAINER_NOT_FOUND' : 'MEMBER_NOT_FOUND');
    if (direction === 'member' && selected.trainerId && !await TrainerMemberAssignment.exists({ gymId: selected.gymId,
      trainerId: selected.trainerId, memberId: profileId, status: 'active' })) fail('MEMBER_NOT_FOUND');
    const gymId = new Types.ObjectId(selected.gymId);
    const filter = { gymId, status, [direction === 'trainer' ? 'trainerId' : 'memberId']: new Types.ObjectId(profileId),
      ...(selected.trainerId ? { trainerId: new Types.ObjectId(selected.trainerId) } : {}) };
    const result = await TrainerMemberAssignment.aggregate([{ $match: filter },
      ...[[TrainerProfile, 'trainerId', 'trainer'], [MemberProfile, 'memberId', 'member']].flatMap(([profileModel, field, alias]) => [
        { $lookup: { from: profileModel.collection.name, localField: field, foreignField: '_id', pipeline: [
          { $match: { gymId } }, { $project: { _id: 1, trainerCode: 1, memberCode: 1, firstName: 1, lastName: 1, phone: 1, status: 1, branchId: 1 } },
        ], as: alias } }, { $unwind: `$${alias}` },
      ]),
      { $facet: { records: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
        { $lookup: { from: Branch.collection.name, localField: direction === 'trainer' ? 'member.branchId' : 'trainer.branchId',
          foreignField: '_id', pipeline: [{ $match: { gymId } }, { $project: { _id: 1 } }], as: 'branch' } }], count: [{ $count: 'total' }] } },
    ]);
    return { data: result[0].records.map((record) => {
      const profile = direction === 'trainer' ? record.member : record.trainer;
      return { [direction === 'trainer' ? 'memberId' : 'trainerId']: String(profile._id),
        [direction === 'trainer' ? 'memberCode' : 'trainerCode']: direction === 'trainer' ? profile.memberCode : profile.trainerCode,
        firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone, status: profile.status,
        ...(record.branch.length ? { branchId: String(record.branch[0]._id) } : {}), assignmentId: String(record._id),
        assignedAt: record.assignedAt, assignmentStatus: record.status, endedAt: record.endedAt };
    }), pagination: { page, limit, total: result[0].count[0]?.total ?? 0 } };
  }
  return {
    async trainerMembers(auth, authorization, trainerId, query) { return view(auth, authorization, trainerId, query, 'trainer'); },
    async memberTrainers(auth, authorization, memberId, query) { return view(auth, authorization, memberId, query, 'member'); },
    // Route guard ensures trainer ownership denials occur before the controller.
    async authorizeRead(auth, authorization, assignmentId) {
      const filter = await readScope(auth, authorization);
      if (assignmentId !== undefined) await existing(filter, assignmentId);
    },
    async create(auth, authorization, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      const data = parse(createAssignment, input);
      await profiles(gymId, data.trainerId, data.memberId, true);
      return dto((await TrainerMemberAssignment.create({ ...data, gymId, status: 'active' })).toObject());
    },
    async get(auth, authorization, assignmentId) {
      return dto(await existing(await readScope(auth, authorization), assignmentId));
    },
    async list(auth, authorization, query) {
      const ownScope = await readScope(auth, authorization);
      const { page, limit, status, trainerId, memberId } = parse(assignmentListInput, query);
      const filter = { gymId: new Types.ObjectId(ownScope.gymId), ...(status ? { status } : {}),
        ...(memberId ? { memberId: new Types.ObjectId(memberId) } : {}) };
      // Intersect a trainer filter with self scope rather than allowing it to replace scope.
      if (ownScope.trainerId && trainerId && ownScope.trainerId !== trainerId.toLowerCase()) {
        return { data: [], pagination: { page, limit, total: 0 } };
      }
      if (ownScope.trainerId || trainerId) filter.trainerId = new Types.ObjectId(ownScope.trainerId || trainerId);
      const result = await TrainerMemberAssignment.aggregate([
        { $match: filter },
        ...[[TrainerProfile, 'trainerId', 'trainer'], [MemberProfile, 'memberId', 'member']].flatMap(([model, field, alias]) => [
          { $lookup: { from: model.collection.name, localField: field, foreignField: '_id',
            pipeline: [{ $match: { gymId: filter.gymId } }, { $project: { _id: 1 } }], as: alias } },
          { $unwind: `$${alias}` },
        ]),
        { $facet: { records: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          count: [{ $count: 'total' }] } },
      ]);
      return { data: result[0].records.map(dto), pagination: { page, limit, total: result[0].count[0]?.total ?? 0 } };
    },
    async update(auth, authorization, assignmentId, input) {
      const { gymId } = await scope(auth, authorization, ['admin']);
      parse(updateAssignment, input);
      const previous = await existing({ gymId }, assignmentId);
      // Only an active record is changed; repeated/concurrent deactivation preserves endedAt.
      const record = await TrainerMemberAssignment.findOneAndUpdate({ _id: assignmentId, gymId, status: 'active' },
        { $set: { status: 'inactive', endedAt: previous.endedAt || new Date() } }, { returnDocument: 'after', runValidators: true }).lean();
      return dto(record || await existing({ gymId }, assignmentId));
    },
  };
}
module.exports = { createAssignmentService };
