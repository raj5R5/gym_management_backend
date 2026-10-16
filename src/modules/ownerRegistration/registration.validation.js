const { z } = require('zod');
const { createUserAccount } = require('../userAccounts/userAccount.validation');
const { createGym, contact } = require('../gyms/gym.validation');
const { password } = require('../auth/auth.validation');

const registerOwner = z.strictObject({
  ownerFullName: createUserAccount.shape.displayName.unwrap(),
  email: createUserAccount.shape.email,
  password,
  gymName: createGym.shape.name,
  gymContactPhone: contact.shape.phone,
});
module.exports = { registerOwner };
