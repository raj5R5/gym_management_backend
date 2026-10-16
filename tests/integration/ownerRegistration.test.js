const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { startServer } = require('../../src/server');
const { initializePasswords, verifyPassword } = require('../../src/modules/auth/password');
const { createOwnerRegistrationService } = require('../../src/modules/ownerRegistration/registration.service');

const path = '/api/v1/auth/register-owner';
const password = randomBytes(24).toString('base64url');
let isolated, config, database, models, app;
const body = (overrides = {}) => ({ ownerFullName: ' Alex River ', email: ' Owner@Example.invalid ', password,
  gymName: ' Example Gym ', gymContactPhone: '+91 9876543210', ...overrides });
const send = (input = body(), application = app) => request(application).post(path).send(input);
function error(response, status, code) {
  assert.equal(response.status, status); assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
async function counts(expected) {
  for (const kind of ['UserAccount', 'Gym', 'GymAccess']) assert.equal(await models[kind].countDocuments(), expected, kind);
}
before(async () => {
  await initializePasswords(); isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
  app = createApp({ config, database });
});
after(async () => { try { if (database) await database.disconnect(); } finally { if (isolated) await isolated.stop(); } });

test('public registration atomically creates active identity, gym and own admin access with safe response', async () => {
  const response = await send(); assert.equal(response.status, 201);
  assert.deepEqual(response.body.data, { accountCreated: true, gymCreated: true });
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
  assert.equal(response.headers['cache-control'], 'no-store'); await counts(1);
  const user = await models.UserAccount.findOne().select('+normalizedEmail +passwordHash').lean();
  const gym = await models.Gym.findOne().select('+nameKey').lean(); const grant = await models.GymAccess.findOne().lean();
  assert.equal(user.email, 'Owner@Example.invalid'); assert.equal(user.normalizedEmail, 'owner@example.invalid');
  assert.equal(user.displayName, 'Alex River'); assert.equal(user.status, 'active');
  assert.ok(user.passwordHash.startsWith('$argon2id$v=19$'));
  assert.deepEqual(Object.fromEntries(user.passwordHash.split('$')[3].split(',').map((entry) => entry.split('='))),
    { m: '65536', t: '3', p: '1' });
  assert.equal(await verifyPassword(user.passwordHash, password), true);
  assert.equal(gym.name, 'Example Gym'); assert.equal(gym.nameKey, 'example gym');
  assert.equal(gym.status, 'active'); assert.equal(gym.contact.phone, '+91 9876543210');
  assert.equal(String(grant.userId), String(user._id)); assert.equal(String(grant.gymId), String(gym._id));
  assert.equal(grant.role, 'admin'); assert.equal(grant.status, 'active');
  assert.equal(await models.AuthSession.countDocuments(), 0);
  assert.equal(await models.RefreshTokenRecord.countDocuments(), 0);
  assert.equal(await models.MemberProfile.countDocuments(), 0);
  assert.doesNotMatch(JSON.stringify(response.body), /password|token|normalizedEmail|Owner@|Example Gym/);
});

test('optional phone may be omitted and original password whitespace is preserved', async () => {
  const privatePassword = ` ${password} `;
  assert.equal((await send(body({ gymContactPhone: undefined, password: privatePassword }))).status, 201);
  assert.equal((await models.Gym.findOne().lean()).contact, undefined);
  const user = await models.UserAccount.findOne().select('+passwordHash').lean();
  assert.equal(await verifyPassword(user.passwordHash, privatePassword), true);
  assert.equal(await verifyPassword(user.passwordHash, privatePassword.trim()), false);
});

test('ordinary login works immediately; authenticated admin is scoped only to their new gym', async () => {
  assert.equal(config.enableBootstrapRoutes, false); assert.equal((await send()).status, 201);
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'owner@example.invalid', password, client: 'mobile' });
  assert.equal(login.status, 200); const token = login.body.data.accessToken;
  assert.equal(login.body.data.gymAccess.length, 1); assert.equal(login.body.data.gymAccess[0].role, 'admin');
  const gymId = login.body.data.gymAccess[0].gymId;
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status, 200);
  assert.equal((await request(app).get(`/api/v1/gyms/${gymId}/members`).set('Authorization', `Bearer ${token}`)).status, 200);
  assert.equal((await send(body({ email: 'other@example.invalid', gymName: 'Other Gym' }))).status, 201);
  const other = await models.Gym.findOne({ name: 'Other Gym' });
  error(await request(app).get(`/api/v1/gyms/${other._id}/members`).set('Authorization', `Bearer ${token}`), 403, 'FORBIDDEN');
  error(await request(app).post('/api/v1/gyms').send({ name: 'Bootstrap denied' }), 404, 'NOT_FOUND');
});

for (const overrides of [
  { ownerFullName: '' }, { ownerFullName: 'x'.repeat(121) }, { email: 'invalid' }, { email: undefined },
  { password: undefined }, { password: 'short' }, { password: 'x'.repeat(129) },
  { password: 'correcthorsebatterystaple' }, { password: 'password1234567890' }, { password: 'abcd'.repeat(8) },
  { password: ' '.repeat(20) }, { gymName: 'A' }, { gymName: 'x'.repeat(121) }, { gymName: undefined },
  { gymContactPhone: '' }, { gymContactPhone: '<invalid>' },
]) {
  test('invalid registration fields/password are rejected before any identity writes', async () => {
    error(await send(body(overrides)), 400, 'VALIDATION_ERROR'); await counts(0);
  });
}
for (const field of ['userId', 'gymId', 'role', 'ownerId', 'ownership', '_id', 'status', 'passwordHash', 'confirmPassword', 'photo']) {
  test(`untrusted ${field} is rejected instead of granting authority`, async () => {
    error(await send(body({ [field]: 'client-supplied' })), 400, 'VALIDATION_ERROR'); await counts(0);
  });
}

test('duplicate email never attaches, reveals or modifies an existing account/gym/access', async () => {
  assert.equal((await send()).status, 201);
  const before = {};
  for (const kind of ['UserAccount', 'Gym', 'GymAccess']) before[kind] = JSON.stringify(await models[kind].find().select('+passwordHash').lean());
  const result = await send(body({ email: 'OWNER@example.invalid', gymName: 'A different gym', password: randomBytes(24).toString('base64url') }));
  error(result, 409, 'DUPLICATE_EMAIL'); await counts(1);
  assert.doesNotMatch(JSON.stringify(result.body), /Owner@|Example Gym|passwordHash|gymId|userId/);
  for (const kind of Object.keys(before)) assert.equal(JSON.stringify(await models[kind].find().select('+passwordHash').lean()), before[kind]);
});

test('duplicate NFKC/whitespace/case-normalized gym name rolls back new account', async () => {
  assert.equal((await send()).status, 201);
  error(await send(body({ email: 'other@example.invalid', gymName: 'ＥＸＡＭＰＬＥ   GYM' })), 409, 'DUPLICATE_GYM_NAME');
  await counts(1); assert.equal(await models.UserAccount.exists({ normalizedEmail: 'other@example.invalid' }), null);
});

for (const kind of ['UserAccount', 'Gym', 'GymAccess']) {
  test(`failure after ${kind} insert aborts every registration write`, async (t) => {
    const original = models[kind].create;
    t.mock.method(models[kind], 'create', async function (...args) {
      await original.apply(this, args); throw new Error('private registration fields must never reach the response');
    });
    const result = await send(); error(result, 500, 'INTERNAL_SERVER_ERROR'); await counts(0);
    assert.doesNotMatch(JSON.stringify(result.body), /private registration fields/);
  });
}

for (const conflict of ['email', 'gymName']) {
  test(`concurrent ${conflict} conflicts create exactly one complete registration`, async () => {
    const second = conflict === 'email' ? { gymName: 'Different Gym' } : { email: 'other@example.invalid' };
    const results = await Promise.all([send(), send(body(second))]);
    assert.deepEqual(results.map((value) => value.status).sort(), [201, 409]); await counts(1);
    error(results.find((value) => value.status === 409), 409, conflict === 'email' ? 'DUPLICATE_EMAIL' : 'DUPLICATE_GYM_NAME');
  });
}

test('registration-specific limit applies without changing auth/session behavior', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) error(await send({}), 400, 'VALIDATION_ERROR');
  const result = await send({}); error(result, 429, 'RATE_LIMITED');
  assert.equal(result.headers['cache-control'], 'no-store'); await counts(0);
});

test('normal startup creates gym uniqueness independently of bootstrap and preserves unrelated indexes', async () => {
  await models.Gym.collection.dropIndex('gym_name_unique');
  await models.Gym.collection.createIndex({ status: 1 }, { name: 'retained_gym_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    assert.equal(lifecycle.bootstrapServer, undefined);
    const indexes = await models.Gym.listIndexes();
    assert.ok(indexes.some((index) => index.name === 'gym_name_unique' && index.unique));
    assert.ok(indexes.some((index) => index.name === 'retained_gym_index'));
    assert.equal((await send(body(), lifecycle.app)).status, 201);
  } finally { await lifecycle.shutdown('test'); }
});

test('hashing is outside retry callbacks; every create uses the same session and cleanup occurs', async () => {
  let hashes = 0, ended = 0, writes = 0;
  const session = { async withTransaction(work, options) {
    assert.deepEqual(options, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    await work(); await work(); // Simulate MongoDB rerunning an aborted callback.
  }, async endSession() { ended += 1; } };
  const create = async (_records, options) => { assert.equal(options.session, session); writes += 1; return [{ _id: 'server-generated' }]; };
  const service = createOwnerRegistrationService({ UserAccount: { db: { startSession: async () => session }, create },
    Gym: { create }, GymAccess: { create }, hash: async () => { hashes += 1; assert.equal(writes, 0); return 'hashed'; } });
  assert.deepEqual(await service.register(body()), { accountCreated: true, gymCreated: true });
  assert.equal(hashes, 1); assert.equal(writes, 6); assert.equal(ended, 1);
});

test('standalone transaction failure fails closed with no partial registration', async () => {
  const standalone = await startTestMongo();
  const localConfig = { ...config, mongoUri: standalone.uri };
  const localDb = createDatabase({ logger: createLogger(localConfig) });
  try {
    await localDb.connect(localConfig); const application = createApp({ config: localConfig, database: localDb });
    await Promise.all(['UserAccount', 'Gym', 'GymAccess'].map((kind) => localDb.connection.models[kind].createIndexes()));
    error(await send(body(), application), 503, 'OWNER_REGISTRATION_STORAGE_UNAVAILABLE');
    for (const kind of ['UserAccount', 'Gym', 'GymAccess']) assert.equal(await localDb.connection.models[kind].countDocuments(), 0);
  } finally { await localDb.disconnect(); await standalone.stop(); }
});
