const { registerOwner } = require('./registration.validation');
const { hashPassword } = require('../auth/password');
const { nameKey } = require('../gyms/gym.service');

function fail(code) { const error = new Error('Owner registration failed.'); error.code = code; throw error; }
function createOwnerRegistrationService({ UserAccount, Gym, GymAccess, hash = hashPassword }) {
  return {
    async register(input) {
      const parsed = registerOwner.safeParse(input);
      if (!parsed.success) fail('VALIDATION_ERROR');
      const data = parsed.data;
      // Hash once, outside a transaction callback that MongoDB may retry.
      const passwordHash = await hash(data.password);
      const session = await UserAccount.db.startSession();
      try {
        await session.withTransaction(async () => {
          // Always insert a NEW identity. An anonymous email match grants no authority.
          const [user] = await UserAccount.create([{ email: data.email,
            displayName: data.ownerFullName, passwordHash, status: 'active' }], { session });
          const [gym] = await Gym.create([{ name: data.gymName, nameKey: nameKey(data.gymName), status: 'active',
            ...(data.gymContactPhone === undefined ? {} : { contact: { phone: data.gymContactPhone } }),
          }], { session });
          await GymAccess.create([{ userId: user._id, gymId: gym._id, role: 'admin', status: 'active' }], { session });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        // No sessions/tokens, security fields or private existing-account data are returned.
        return { accountCreated: true, gymCreated: true };
      } catch (error) {
        if (error.code === 20 || error.originalError?.code === 20) fail('OWNER_REGISTRATION_STORAGE_UNAVAILABLE');
        if (error.code === 11000 && error.keyPattern?.nameKey) fail('DUPLICATE_GYM_NAME');
        throw error;
      } finally { await session.endSession(); }
    },
  };
}
module.exports = { createOwnerRegistrationService };
