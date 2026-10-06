function nameKey(name) {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function gymDto(gym) {
  return {
    id: String(gym._id), name: gym.name, status: gym.status,
    contact: gym.contact, settings: gym.settings,
    createdAt: gym.createdAt, updatedAt: gym.updatedAt,
  };
}

function createGymService(Gym) {
  async function requireGym(gymId) {
    const gym = await Gym.findById(gymId).lean();
    if (!gym) {
      const error = new Error('Gym not found.');
      error.code = 'GYM_NOT_FOUND';
      throw error;
    }
    return gym;
  }

  return {
    requireGym,
    async create(input) {
      const gym = await Gym.create({ ...input, nameKey: nameKey(input.name) });
      return gymDto(gym.toObject());
    },
    async get(gymId) { return gymDto(await requireGym(gymId)); },
    async list({ page, limit }) {
      const [gyms, total] = await Promise.all([
        Gym.find().sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Gym.countDocuments(),
      ]);
      return { data: gyms.map(gymDto), pagination: { page, limit, total } };
    },
    async update(gymId, input) {
      const update = { ...input };
      if (input.name !== undefined) update.nameKey = nameKey(input.name);
      // Nested contact/settings objects replace their previous values as a whole.
      const gym = await Gym.findOneAndUpdate({ _id: gymId }, { $set: update },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!gym) {
        const error = new Error('Gym not found.');
        error.code = 'GYM_NOT_FOUND';
        throw error;
      }
      return gymDto(gym);
    },
  };
}

module.exports = { createGymService, nameKey };
