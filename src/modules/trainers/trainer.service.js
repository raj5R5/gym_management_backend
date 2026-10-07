const { objectId } = require('../gyms/gym.validation');
const { createTrainer, updateTrainer, trainerListInput } = require('./trainer.validation');
function fail(code) { const error = new Error('Trainer operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('VALIDATION_ERROR');
  return result.data;
}
function trainerDto(trainer) {
  return { id: String(trainer._id), gymId: String(trainer.gymId), userId: trainer.userId ? String(trainer.userId) : undefined,
    branchId: trainer.branchId ? String(trainer.branchId) : undefined, trainerCode: trainer.trainerCode,
    firstName: trainer.firstName, lastName: trainer.lastName, phone: trainer.phone,
    dateOfBirth: trainer.dateOfBirth ? trainer.dateOfBirth.toISOString().slice(0, 10) : undefined,
    gender: trainer.gender, address: trainer.address, specializations: trainer.specializations,
    status: trainer.status, createdAt: trainer.createdAt, updatedAt: trainer.updatedAt };
}
function createTrainerService({ TrainerProfile, Branch, UserAccount, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    // Re-resolve server-side access for service callers, never trust a body tenant/role.
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    return current.gymId;
  }
  async function activeBranch(gymId, branchId) {
    if (!branchId) return;
    const branch = await Branch.findOne({ _id: branchId, gymId }).select('status').lean();
    if (!branch) fail('BRANCH_NOT_FOUND');
    if (branch.status !== 'active') fail('FORBIDDEN');
  }
  async function existing(gymId, trainerId) {
    const id = parse(objectId, trainerId);
    const trainer = await TrainerProfile.findOne({ _id: id, gymId }).lean();
    if (!trainer) fail('TRAINER_NOT_FOUND');
    return trainer;
  }
  return {
    async create(auth, authorization, input, { linkedUserId } = {}) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(createTrainer, input);
      await activeBranch(gymId, data.branchId);
      // Reserved for trusted server callers; HTTP bodies cannot set this relationship.
      const userId = linkedUserId === undefined ? undefined : parse(objectId, linkedUserId);
      if (userId && !await UserAccount.exists({ _id: userId })) fail('USER_ACCOUNT_NOT_FOUND');
      const record = { ...data, gymId, ...(userId ? { userId } : {}) };
      for (const key of Object.keys(record)) if (record[key] === null) delete record[key];
      return trainerDto((await TrainerProfile.create(record)).toObject());
    },
    async get(auth, authorization, trainerId) {
      const gymId = await scope(auth, authorization, ['admin']);
      return trainerDto(await existing(gymId, trainerId));
    },
    async list(auth, authorization, query) {
      const gymId = await scope(auth, authorization, ['admin']);
      const { page, limit, status, search } = parse(trainerListInput, query);
      const filter = { gymId, ...(status ? { status } : {}) };
      if (search) {
        const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = ['trainerCode', 'firstName', 'lastName', 'phone', 'specializations'].map((field) =>
          ({ [field]: { $regex: literal, $options: 'i' } }));
      }
      const [records, total] = await Promise.all([
        TrainerProfile.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        TrainerProfile.countDocuments(filter),
      ]);
      return { data: records.map(trainerDto), pagination: { page, limit, total } };
    },
    async update(auth, authorization, trainerId, input) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(updateTrainer, input);
      await existing(gymId, trainerId);
      await activeBranch(gymId, data.branchId);
      const set = {}, unset = {};
      for (const [key, value] of Object.entries(data)) {
        if (value === null) unset[key] = ''; else set[key] = value;
      }
      const trainer = await TrainerProfile.findOneAndUpdate({ _id: trainerId, gymId },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!trainer) fail('TRAINER_NOT_FOUND');
      return trainerDto(trainer);
    },
  };
}
module.exports = { createTrainerService };
