const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
const options = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

function createPasswordTools({ hash = argon2.hash, verify = argon2.verify } = {}) {
  let dummyHash;
  let initialization;
  function hashPassword(password) { return hash(password, options); }
  function initializePasswords() {
    if (!initialization) {
      initialization = (async () => {
        try { dummyHash = await hashPassword(randomBytes(32).toString('hex')); }
        catch {
          const error = new Error('Password verification initialization failed.');
          error.code = 'PASSWORD_INITIALIZATION_FAILED';
          throw error;
        }
      })();
    }
    return initialization;
  }
  async function verifyPassword(hashValue, password) {
    if (!dummyHash) {
      const error = new Error('Password verification is not initialized.');
      error.code = 'PASSWORD_INITIALIZATION_FAILED';
      throw error;
    }
    try { const valid = await verify(hashValue || dummyHash, password); return Boolean(hashValue) && valid; }
    catch { return false; }
  }
  return { hashPassword, verifyPassword, initializePasswords };
}
module.exports = { ...createPasswordTools(), createPasswordTools };
