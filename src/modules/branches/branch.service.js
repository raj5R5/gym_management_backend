const { nameKey } = require('../gyms/gym.service');

function branchDto(branch) {
  return {
    id: String(branch._id), gymId: String(branch.gymId), name: branch.name,
    address: branch.address, contact: branch.contact, status: branch.status,
    createdAt: branch.createdAt, updatedAt: branch.updatedAt,
  };
}

function missingBranch() {
  const error = new Error('Branch not found.');
  error.code = 'BRANCH_NOT_FOUND';
  return error;
}

function createBranchService(Branch, gymService) {
  return {
    async create(gymId, input) {
      await gymService.requireGym(gymId);
      const branch = await Branch.create({ ...input, gymId, nameKey: nameKey(input.name) });
      return branchDto(branch.toObject());
    },
    async get(gymId, branchId) {
      await gymService.requireGym(gymId);
      const branch = await Branch.findOne({ _id: branchId, gymId }).lean();
      if (!branch) throw missingBranch();
      return branchDto(branch);
    },
    async list(gymId, { page, limit }) {
      await gymService.requireGym(gymId);
      const [branches, total] = await Promise.all([
        Branch.find({ gymId }).sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).lean(),
        Branch.countDocuments({ gymId }),
      ]);
      return { data: branches.map(branchDto), pagination: { page, limit, total } };
    },
    async update(gymId, branchId, input) {
      await gymService.requireGym(gymId);
      const update = { ...input };
      if (input.name !== undefined) update.nameKey = nameKey(input.name);
      const branch = await Branch.findOneAndUpdate({ _id: branchId, gymId }, { $set: update },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!branch) throw missingBranch();
      return branchDto(branch);
    },
  };
}

module.exports = { createBranchService };
