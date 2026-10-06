function userDto(user) {
  return {
    id: String(user._id), email: user.email, displayName: user.displayName,
    status: user.status, createdAt: user.createdAt, updatedAt: user.updatedAt,
  };
}

function createUserAccountService(UserAccount) {
  async function requireUser(userId) {
    const user = await UserAccount.findById(userId).lean();
    if (!user) {
      const error = new Error('User account not found.');
      error.code = 'USER_ACCOUNT_NOT_FOUND';
      throw error;
    }
    return user;
  }
  return {
    requireUser,
    async create({ email, displayName, status }) {
      const user = await UserAccount.create({ email, displayName, status });
      return userDto(user.toObject());
    },
    async get(userId) { return userDto(await requireUser(userId)); },
    async list({ page, limit }) {
      const [users, total] = await Promise.all([
        UserAccount.find().sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        UserAccount.countDocuments(),
      ]);
      return { data: users.map(userDto), pagination: { page, limit, total } };
    },
  };
}

module.exports = { createUserAccountService };
