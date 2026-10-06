function accessDto(access) {
  return {
    id: String(access._id), userId: String(access.userId), gymId: String(access.gymId),
    role: access.role, status: access.status,
    createdAt: access.createdAt, updatedAt: access.updatedAt,
  };
}

function createGymAccessService(GymAccess, gymService, userService) {
  return {
    async create(gymId, { userId, role, status }) {
      await gymService.requireGym(gymId);
      await userService.requireUser(userId);
      const access = await GymAccess.create({ gymId, userId, role, status });
      return accessDto(access.toObject());
    },
    async get(gymId, accessId) {
      await gymService.requireGym(gymId);
      const access = await GymAccess.findOne({ _id: accessId, gymId }).lean();
      if (!access) {
        const error = new Error('Gym access not found.');
        error.code = 'GYM_ACCESS_NOT_FOUND';
        throw error;
      }
      return accessDto(access);
    },
    async list(gymId, { page, limit }) {
      await gymService.requireGym(gymId);
      const [records, total] = await Promise.all([
        GymAccess.find({ gymId }).sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).lean(),
        GymAccess.countDocuments({ gymId }),
      ]);
      return { data: records.map(accessDto), pagination: { page, limit, total } };
    },
  };
}

module.exports = { createGymAccessService };
