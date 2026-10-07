const { objectId } = require('../gyms/gym.validation');
const { createPlan, updatePlan, planListInput } = require('./plan.validation');
function fail(code) { const error = new Error('Plan operation failed.'); error.code = code; throw error; }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail('VALIDATION_ERROR');
  return result.data;
}
function dto(plan) {
  return { id: String(plan._id), gymId: String(plan.gymId), name: plan.name,
    durationDays: plan.durationDays, price: plan.price, status: plan.status,
    description: plan.description, createdAt: plan.createdAt, updatedAt: plan.updatedAt };
}
function createPlanService({ MembershipPlan, authorizationService }) {
  async function scope(auth, authorization, allowed) {
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    return current.gymId;
  }
  return {
    async create(auth, authorization, input) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(createPlan, input);
      if (data.description === null) delete data.description;
      return dto((await MembershipPlan.create({ ...data, gymId, normalizedName: data.name.toLowerCase() })).toObject());
    },
    async get(auth, authorization, planId) {
      const gymId = await scope(auth, authorization, ['admin', 'trainer']);
      const record = await MembershipPlan.findOne({ _id: parse(objectId, planId), gymId }).lean();
      if (!record) fail('PLAN_NOT_FOUND');
      return dto(record);
    },
    async list(auth, authorization, query) {
      const gymId = await scope(auth, authorization, ['admin', 'trainer']);
      const { page, limit, status, search } = parse(planListInput, query);
      const filter = { gymId, ...(status ? { status } : {}) };
      if (search) filter.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const [records, total] = await Promise.all([
        MembershipPlan.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        MembershipPlan.countDocuments(filter),
      ]);
      return { data: records.map(dto), pagination: { page, limit, total } };
    },
    async update(auth, authorization, planId, input) {
      const gymId = await scope(auth, authorization, ['admin']);
      const data = parse(updatePlan, input);
      const unset = data.description === null;
      if (unset) delete data.description;
      if (data.name !== undefined) data.normalizedName = data.name.toLowerCase();
      const record = await MembershipPlan.findOneAndUpdate({ _id: parse(objectId, planId), gymId },
        { ...(Object.keys(data).length ? { $set: data } : {}), ...(unset ? { $unset: { description: '' } } : {}) },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!record) fail('PLAN_NOT_FOUND');
      return dto(record);
    },
  };
}
module.exports = { createPlanService };
