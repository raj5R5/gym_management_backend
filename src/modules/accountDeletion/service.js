const { normalizeEmail } = require('../userAccounts/userAccount.validation');
const { verifyPassword } = require('../auth/password');

function createAccountDeletionService({ UserAccount, AccountDeletionRequest }) {
  const dto = (row) => row ? { id: String(row._id), userId: String(row.userId), status: row.status,
    requestedAt: row.requestedAt.toISOString() } : null;
  async function save(userId) {
    const now = new Date();
    let row;
    try {
      row = await AccountDeletionRequest.findOneAndUpdate({ userId },
        { $setOnInsert: { userId, status: 'requested', requestedAt: now } },
        { upsert: true, returnDocument: 'after', runValidators: true }).lean();
    } catch (error) {
      if (error.code !== 11000) throw error;
      row = await AccountDeletionRequest.findOne({ userId }).lean();
      if (!row) throw error;
    }
    return dto(row);
  }
  return {
    async status(context) {
      return dto(await AccountDeletionRequest.findOne({ userId: context.user._id }).lean());
    },
    async request(context, currentPassword) {
      const user = await UserAccount.findById(context.user._id).select('+passwordHash').lean();
      const valid = await verifyPassword(user?.passwordHash, currentPassword);
      if (!valid || user?.status !== 'active') {
        const error = new Error('Account verification failed.');
        error.code = 'ACCOUNT_DELETION_PASSWORD_INVALID'; throw error;
      }
      return save(user._id);
    },
    async requestFromWeb(email, currentPassword) {
      const user = await UserAccount.findOne({ normalizedEmail: normalizeEmail(email) }).select('+passwordHash').lean();
      // Same generic error for nonexistent accounts and wrong passwords. An
      // inactive account may still request deletion with its existing password.
      if (!await verifyPassword(user?.passwordHash, currentPassword)) {
        const error = new Error('Account verification failed.'); error.code = 'INVALID_CREDENTIALS'; throw error;
      }
      return save(user._id);
    },
  };
}
module.exports = { createAccountDeletionService };
