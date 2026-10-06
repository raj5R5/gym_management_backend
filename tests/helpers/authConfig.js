const { randomBytes } = require('node:crypto');
// Independent test configuration; no source-code secret and no real .env is loaded.
const testAuthEnv = {
  JWT_ACCESS_SECRET: randomBytes(64).toString('hex'),
  JWT_ISSUER: 'gym-test-api', JWT_AUDIENCE: 'gym-test-client',
};
module.exports = { testAuthEnv };
