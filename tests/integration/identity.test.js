const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { loadConfig } = require('../../src/config/env');
const { createLogger } = require('../../src/config/logger');
const { createDatabase } = require('../../src/config/database');
const { createApp } = require('../../src/app');
const { startServer } = require('../../src/server');

let isolated;
let config;
let database;
let app;
let UserAccount;
let GymAccess;
let Gym;
const usersPath = '/api/v1/user-accounts';
const accessPath = (gymId) => `/api/v1/gyms/${gymId}/access`;
const missingId = () => String(new mongoose.Types.ObjectId());

before(async () => {
  isolated = await startTestMongo();
  config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri,
    ENABLE_BOOTSTRAP_ROUTES: 'true' });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  app = createApp({ config, database });
  ({ UserAccount, GymAccess, Gym } = database.connection.models);
  await Promise.all([UserAccount.createIndexes(), GymAccess.createIndexes(), Gym.createIndexes()]);
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  app = createApp({ config, database });
  await Promise.all([UserAccount.deleteMany({}), GymAccess.deleteMany({}), Gym.deleteMany({})]);
});

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, code);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
async function user(email = 'person@example.com', options = {}) {
  const response = await request(app).post(usersPath).send({ email, ...options });
  assert.equal(response.status, 201);
  return response.body.data;
}
async function gym(name = 'Main Gym') {
  const response = await request(app).post('/api/v1/gyms').send({ name });
  assert.equal(response.status, 201);
  return response.body.data;
}
async function access(gymId, userId, role = 'member', options = {}) {
  const response = await request(app).post(accessPath(gymId)).send({ userId, role, ...options });
  assert.equal(response.status, 201);
  return response.body.data;
}

test('creates and retrieves account identity with safe DTO and inactive default', async () => {
  const account = await user(' Person@Example.COM ', { displayName: ' Person Name ' });
  assert.equal(account.email, 'Person@Example.COM');
  assert.equal(account.displayName, 'Person Name');
  assert.equal(account.status, 'inactive');
  assert.ok(account.id && account.createdAt && account.updatedAt);
  for (const field of ['normalizedEmail', '_id', '__v', 'password', 'role', 'gymId']) {
    assert.equal(account[field], undefined);
  }
  const response = await request(app).get(`${usersPath}/${account.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, account);
  assert.equal(response.headers['x-api-mode'], 'development-bootstrap');
});

test('normalizes email server-side without collapsing plus tags or dots', async () => {
  const account = await user(' Mixed.Case+Tag@Example.COM ');
  const persisted = await UserAccount.findById(account.id).select('+normalizedEmail').lean();
  assert.equal(persisted.normalizedEmail, 'mixed.case+tag@example.com');
  await user('mixedcase+tag@example.com');
  await user('mixed.case@example.com');
  assert.equal(await UserAccount.countDocuments(), 3);
});

test('rejects invalid emails, identity fields, and unknown privileged/security fields', async () => {
  for (const body of [{}, { email: '' }, { email: 'not-an-email' }, { email: 'a@' },
    { email: 'good@example.com', displayName: ' ' },
    { email: 'good@example.com', displayName: 'x'.repeat(121) },
    { email: 'good@example.com', role: 'admin' },
    { email: 'good@example.com', gymId: missingId() },
    { email: 'good@example.com', normalizedEmail: 'other@example.com' },
    { email: 'good@example.com', password: 'not-stored' },
    { email: 'good@example.com', permissions: ['all'] }]) {
    expectError(await request(app).post(usersPath).send(body), 400, 'VALIDATION_ERROR');
  }
  assert.equal(await UserAccount.countDocuments(), 0);
});

test('duplicate normalized email returns a safe conflict including concurrent creation', async () => {
  await user('Person@Example.COM');
  const duplicate = await request(app).post(usersPath).send({ email: ' person@example.com ' });
  expectError(duplicate, 409, 'DUPLICATE_EMAIL');
  assert.equal(JSON.stringify(duplicate.body).includes('person@example.com'), false);
  const raced = await Promise.all([1, 2].map(() => request(app).post(usersPath).send({ email: 'race@example.com' })));
  assert.deepEqual(raced.map((response) => response.status).sort(), [201, 409]);
});

test('account statuses are validated independently from access statuses', async () => {
  for (const status of ['active', 'inactive', 'suspended']) {
    const account = await user(`${status}@example.com`, { status });
    assert.equal(account.status, status);
  }
  expectError(await request(app).post(usersPath).send({ email: 'invalid@example.com', status: 'deleted' }),
    400, 'VALIDATION_ERROR');
});

test('lists accounts with bounded pagination and hides normalization fields', async () => {
  await user('first@example.com');
  await user('second@example.com');
  const response = await request(app).get(`${usersPath}?page=1&limit=1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.deepEqual(response.body.meta.pagination, { page: 1, limit: 1, total: 2 });
  assert.equal(response.body.data[0].normalizedEmail, undefined);
  expectError(await request(app).get(`${usersPath}?limit=101`), 400, 'VALIDATION_ERROR');
});

test('missing and malformed account identifiers are handled consistently', async () => {
  expectError(await request(app).get(`${usersPath}/${missingId()}`), 404, 'USER_ACCOUNT_NOT_FOUND');
  expectError(await request(app).get(`${usersPath}/invalid`), 400, 'VALIDATION_ERROR');
});

test('creates and retrieves gym-scoped access with an inactive default', async () => {
  const account = await user();
  const organization = await gym();
  const grant = await access(organization.id, account.id);
  assert.equal(grant.userId, account.id);
  assert.equal(grant.gymId, organization.id);
  assert.equal(grant.role, 'member');
  assert.equal(grant.status, 'inactive');
  assert.ok(grant.createdAt && grant.updatedAt);
  const response = await request(app).get(`${accessPath(organization.id)}/${grant.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, grant);
});

test('rejects nonexistent gym and nonexistent user without persisting access', async () => {
  const account = await user();
  const organization = await gym();
  expectError(await request(app).post(accessPath(missingId())).send({ userId: account.id, role: 'member' }),
    404, 'GYM_NOT_FOUND');
  expectError(await request(app).post(accessPath(organization.id)).send({ userId: missingId(), role: 'member' }),
    404, 'USER_ACCOUNT_NOT_FOUND');
  assert.equal(await GymAccess.countDocuments(), 0);
});

test('one role per user/gym is enforced even across statuses and concurrent requests', async () => {
  const account = await user();
  const organization = await gym();
  await access(organization.id, account.id, 'member', { status: 'inactive' });
  expectError(await request(app).post(accessPath(organization.id)).send({ userId: account.id, role: 'admin', status: 'active' }),
    409, 'DUPLICATE_GYM_ACCESS');
  const second = await user('second@example.com');
  const raced = await Promise.all(['member', 'trainer'].map((role) => request(app)
    .post(accessPath(organization.id)).send({ userId: second.id, role })));
  assert.deepEqual(raced.map((response) => response.status).sort(), [201, 409]);
});

test('all initial roles are accepted only as explicit bootstrap provisioning values', async () => {
  const organization = await gym();
  for (const role of ['admin', 'trainer', 'member']) {
    const account = await user(`${role}@example.com`);
    assert.equal((await access(organization.id, account.id, role)).role, role);
  }
});

test('rejects invalid/missing roles, malformed IDs and body-supplied ownership', async () => {
  const organization = await gym();
  const account = await user();
  for (const body of [{ userId: account.id }, { userId: account.id, role: 'owner' },
    { userId: account.id, role: 'Admin' }, { userId: 'invalid', role: 'member' },
    { userId: account.id, role: 'member', gymId: missingId() },
    { userId: account.id, role: 'member', permissions: ['all'] },
    { userId: account.id, role: 'member', status: 'invalid' }]) {
    expectError(await request(app).post(accessPath(organization.id)).send(body), 400, 'VALIDATION_ERROR');
  }
  expectError(await request(app).post(accessPath('invalid')).send({ userId: account.id, role: 'member' }),
    400, 'VALIDATION_ERROR');
  assert.equal(await GymAccess.countDocuments(), 0);
});

test('access statuses do not modify the global account status', async () => {
  const account = await user('suspended@example.com', { status: 'suspended' });
  for (const status of ['active', 'inactive', 'suspended']) {
    const organization = await gym(`${status} Gym`);
    const grant = await access(organization.id, account.id, 'member', { status });
    assert.equal(grant.status, status);
  }
  assert.equal((await request(app).get(`${usersPath}/${account.id}`)).body.data.status, 'suspended');
});

test('one account can have different roles in multiple gyms', async () => {
  const account = await user();
  const first = await gym('First Gym');
  const second = await gym('Second Gym');
  assert.equal((await access(first.id, account.id, 'admin')).role, 'admin');
  assert.equal((await access(second.id, account.id, 'member')).role, 'member');
  assert.equal(await GymAccess.countDocuments({ userId: account.id }), 2);
});

test('multiple accounts can access one gym and lists remain scoped', async () => {
  const first = await gym('First Gym');
  const second = await gym('Second Gym');
  const one = await user('one@example.com');
  const two = await user('two@example.com');
  await access(first.id, one.id);
  await access(first.id, two.id);
  await access(second.id, one.id);
  const response = await request(app).get(`${accessPath(first.id)}?limit=1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.meta.pagination.total, 2);
  assert.equal(response.body.data[0].gymId, first.id);
  expectError(await request(app).get(accessPath(missingId())), 404, 'GYM_NOT_FOUND');
});

test('cross-gym access inspection cannot reveal records from another gym', async () => {
  const account = await user();
  const first = await gym('First Gym');
  const second = await gym('Second Gym');
  const grant = await access(first.id, account.id);
  expectError(await request(app).get(`${accessPath(second.id)}/${grant.id}`), 404, 'GYM_ACCESS_NOT_FOUND');
  expectError(await request(app).get(`${accessPath(first.id)}/${missingId()}`), 404, 'GYM_ACCESS_NOT_FOUND');
  expectError(await request(app).get(`${accessPath(first.id)}/invalid`), 400, 'VALIDATION_ERROR');
  assert.deepEqual((await request(app).get(accessPath(second.id))).body.data, []);
});

test('bootstrap enablement and environment gates protect account/access reads and writes', async () => {
  const paths = [usersPath, accessPath(missingId())];
  for (const [nodeEnv, enabled] of [['development', false], ['test', false], ['staging', true], ['production', true]]) {
    const disabled = createApp({ config: { ...config, nodeEnv, enableBootstrapRoutes: enabled }, database });
    for (const path of paths) {
      expectError(await request(disabled).get(path), 404, 'NOT_FOUND');
      expectError(await request(disabled).post(path).send({}), 404, 'NOT_FOUND');
    }
  }
  assert.equal(await UserAccount.countDocuments(), 0);
  assert.equal(await GymAccess.countDocuments(), 0);
});

test('non-loopback bootstrap clients are rejected even with a forged forwarding header', async (t) => {
  // The limiter intentionally diagnoses forwarding headers while proxy trust is off.
  // Assert that diagnostic rather than printing an expected warning in the test run.
  const warnings = [];
  t.mock.method(console, 'error', (warning) => warnings.push(warning));
  const remote = express();
  remote.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.10', configurable: true });
    next();
  });
  remote.use(app);
  for (const path of [usersPath, accessPath(missingId()), '/api/v1/gyms']) {
    expectError(await request(remote).get(path).set('X-Forwarded-For', '127.0.0.1'), 403, 'BOOTSTRAP_FORBIDDEN');
    expectError(await request(remote).post(path).send({}), 403, 'BOOTSTRAP_FORBIDDEN');
  }
  assert.ok(warnings.some((warning) => warning.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'));
});

test('no account or access update/deletion endpoints exist', async () => {
  const account = await user();
  const organization = await gym();
  const grant = await access(organization.id, account.id);
  for (const path of [`${usersPath}/${account.id}`, `${accessPath(organization.id)}/${grant.id}`]) {
    expectError(await request(app).patch(path).send({ status: 'active' }), 404, 'NOT_FOUND');
    expectError(await request(app).delete(path), 404, 'NOT_FOUND');
  }
});

test('bootstrap startup creates identity indexes before serving', async () => {
  await Promise.all([UserAccount.collection.dropIndexes(), GymAccess.collection.dropIndexes()]);
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database });
  try {
    assert.ok((await UserAccount.listIndexes()).some((index) => index.name === 'account_email_unique' && index.unique));
    assert.ok((await GymAccess.listIndexes()).some((index) => index.name === 'access_user_gym_unique' && index.unique));
    assert.equal((await request(lifecycle.server).get(usersPath)).status, 200);
  } finally { await lifecycle.shutdown('test'); }
});
