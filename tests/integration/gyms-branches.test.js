const { testAuthEnv } = require('../helpers/authConfig');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { loadConfig } = require('../../src/config/env');
const { createApp, createBootstrapApp } = require('../../src/app');
const { createLogger } = require('../../src/config/logger');
const { createDatabase } = require('../../src/config/database');
const { startServer } = require('../../src/server');

let isolated;
let database;
let config;
let app;
let Gym;
let Branch;
const missingId = () => String(new mongoose.Types.ObjectId());
const address = { line1: '10 Main Road', city: 'Pune', countryCode: 'IN', postalCode: '411001' };
const gymPath = '/api/v1/gyms';
const branchPath = (gymId) => `${gymPath}/${gymId}/branches`;

before(async () => {
  isolated = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri,
    ENABLE_BOOTSTRAP_ROUTES: 'true' });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  app = createBootstrapApp({ config, database });
  ({ Gym, Branch } = database.connection.models);
  // Indexes are real MongoDB constraints, not mocked uniqueness checks.
  await Promise.all([Gym.createIndexes(), Branch.createIndexes()]);
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  app = createBootstrapApp({ config, database });
  await Promise.all([Gym.deleteMany({}), Branch.deleteMany({})]);
});

async function newGym(name = 'Main Gym') {
  const response = await request(app).post(gymPath).send({ name });
  assert.equal(response.status, 201);
  return response.body.data;
}
async function newBranch(gymId, name = 'Central Branch') {
  const response = await request(app).post(branchPath(gymId)).send({ name, address });
  assert.equal(response.status, 201);
  return response.body.data;
}
function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
  assert.equal(response.body.error.stack, undefined);
}

test('creates Gym with defaults, contact/settings, timestamps and public DTO', async () => {
  const response = await request(app).post(gymPath).send({ name: ' Main Gym ',
    contact: { email: 'info@example.com', phone: '+91 9876543210' }, settings: { timezone: 'Asia/Kolkata' } });
  assert.equal(response.status, 201);
  assert.equal(response.headers['x-api-mode'], 'development-bootstrap');
  const gym = response.body.data;
  assert.equal(gym.name, 'Main Gym');
  assert.equal(gym.status, 'active');
  assert.equal(gym.contact.email, 'info@example.com');
  assert.equal(gym.settings.timezone, 'Asia/Kolkata');
  assert.ok(gym.createdAt && gym.updatedAt && gym.id);
  assert.equal(gym.nameKey, undefined);
  assert.equal(gym._id, undefined);
  assert.equal(gym.__v, undefined);
});

test('retrieves and updates Gym without resetting omitted fields', async () => {
  const gym = await newGym();
  assert.equal((await request(app).get(`${gymPath}/${gym.id}`)).body.data.name, 'Main Gym');
  const update = await request(app).patch(`${gymPath}/${gym.id}`).send({ name: 'Renamed Gym', status: 'inactive' });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.name, 'Renamed Gym');
  assert.equal(update.body.data.status, 'inactive');
  const contactOnly = await request(app).patch(`${gymPath}/${gym.id}`).send({ contact: { phone: '9876543210' } });
  assert.equal(contactOnly.body.data.status, 'inactive');
  assert.equal(contactOnly.body.data.name, 'Renamed Gym');
});

test('lists Gyms with bounded pagination', async () => {
  await newGym('First Gym');
  await newGym('Second Gym');
  const response = await request(app).get(`${gymPath}?page=1&limit=1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.deepEqual(response.body.meta.pagination, { page: 1, limit: 1, total: 2 });
});

test('creates and retrieves a Branch with parent reference', async () => {
  const gym = await newGym();
  const branch = await newBranch(gym.id);
  assert.equal(branch.gymId, gym.id);
  assert.equal(branch.status, 'active');
  assert.deepEqual(branch.address, address);
  const response = await request(app).get(`${branchPath(gym.id)}/${branch.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, branch);
});

test('lists only branches belonging to the requested Gym', async () => {
  const first = await newGym('First Gym');
  const second = await newGym('Second Gym');
  await newBranch(first.id, 'First Branch');
  await newBranch(first.id, 'Second Branch');
  await newBranch(second.id, 'Other Branch');
  const response = await request(app).get(`${branchPath(first.id)}?limit=1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].gymId, first.id);
  assert.equal(response.body.meta.pagination.total, 2);
});

test('updates Branch and preserves its parent and omitted status', async () => {
  const gym = await newGym();
  const branch = await newBranch(gym.id);
  const path = `${branchPath(gym.id)}/${branch.id}`;
  const response = await request(app).patch(path).send({ name: 'Renamed Branch', status: 'inactive' });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.name, 'Renamed Branch');
  assert.equal(response.body.data.gymId, gym.id);
  const contactOnly = await request(app).patch(path).send({ contact: { email: 'branch@example.com' } });
  assert.equal(contactOnly.body.data.status, 'inactive');
  const newAddress = { line1: '20 Other Road', city: 'Mumbai', countryCode: 'IN' };
  const moved = await request(app).patch(path).send({ address: newAddress });
  assert.deepEqual(moved.body.data.address, newAddress);
});

test('rejects invalid Gym input, unknown fields, statuses, contact and settings', async () => {
  for (const body of [{}, { name: ' ' }, { name: 'x'.repeat(121) },
    { name: 'Gym', status: 'deleted' }, { name: 'Gym', role: 'Admin' },
    { name: 'Gym', contact: { email: 'bad' } }, { name: 'Gym', contact: { phone: '-------' } },
    { name: 'Gym', settings: { timezone: 'Invalid/Zone' } }, { name: 'Gym', settings: { unapproved: true } }]) {
    error(await request(app).post(gymPath).send(body), 400, 'VALIDATION_ERROR');
  }
  const gym = await newGym();
  error(await request(app).patch(`${gymPath}/${gym.id}`).send({}), 400, 'VALIDATION_ERROR');
  for (const query of ['page=0', 'limit=101', 'limit=-1', 'unknown=1']) {
    error(await request(app).get(`${gymPath}?${query}`), 400, 'VALIDATION_ERROR');
  }
});

test('rejects invalid Branch input and client-supplied parent/ownership', async () => {
  const gym = await newGym();
  for (const body of [{ name: 'Branch' }, { name: 'Branch', address: {} },
    { name: 'Branch', address: { ...address, countryCode: 'india' } },
    { name: 'Branch', address, gymId: missingId() },
    { name: 'Branch', address, ownerId: missingId() },
    { name: 'Branch', address, status: 'archived' }]) {
    error(await request(app).post(branchPath(gym.id)).send(body), 400, 'VALIDATION_ERROR');
  }
  const branch = await newBranch(gym.id);
  error(await request(app).patch(`${branchPath(gym.id)}/${branch.id}`).send({ gymId: missingId() }),
    400, 'VALIDATION_ERROR');
  error(await request(app).patch(`${branchPath(gym.id)}/${branch.id}`).send({}), 400, 'VALIDATION_ERROR');
});

test('invalid Gym and Branch IDs return 400, not cast errors', async () => {
  error(await request(app).get(`${gymPath}/invalid`), 400, 'VALIDATION_ERROR');
  error(await request(app).get(`${gymPath}/invalid/branches`), 400, 'VALIDATION_ERROR');
  const gym = await newGym();
  error(await request(app).get(`${branchPath(gym.id)}/invalid`), 400, 'VALIDATION_ERROR');
  error(await request(app).patch(`${branchPath(gym.id)}/invalid`).send({ name: 'Valid Name' }),
    400, 'VALIDATION_ERROR');
});

test('missing Gym cannot be retrieved/updated or acquire branches', async () => {
  const id = missingId();
  error(await request(app).get(`${gymPath}/${id}`), 404, 'GYM_NOT_FOUND');
  error(await request(app).patch(`${gymPath}/${id}`).send({ name: 'Valid Name' }), 404, 'GYM_NOT_FOUND');
  error(await request(app).get(branchPath(id)), 404, 'GYM_NOT_FOUND');
  error(await request(app).post(branchPath(id)).send({ name: 'Branch', address }), 404, 'GYM_NOT_FOUND');
  assert.equal(await Branch.countDocuments(), 0);
});

test('missing Branch returns consistent 404 for get and update', async () => {
  const gym = await newGym();
  const path = `${branchPath(gym.id)}/${missingId()}`;
  error(await request(app).get(path), 404, 'BRANCH_NOT_FOUND');
  error(await request(app).patch(path).send({ name: 'Valid Name' }), 404, 'BRANCH_NOT_FOUND');
});

test('cross-gym Branch lookup and update cannot expose or modify the resource', async () => {
  const first = await newGym('First Gym');
  const second = await newGym('Second Gym');
  const branch = await newBranch(first.id);
  const wrongPath = `${branchPath(second.id)}/${branch.id}`;
  error(await request(app).get(wrongPath), 404, 'BRANCH_NOT_FOUND');
  error(await request(app).patch(wrongPath).send({ name: 'Stolen Branch' }), 404, 'BRANCH_NOT_FOUND');
  const correct = await request(app).get(`${branchPath(first.id)}/${branch.id}`);
  assert.equal(correct.body.data.name, 'Central Branch');
  assert.equal(correct.body.data.gymId, first.id);
});

test('Gym name uniqueness is case/whitespace insensitive on creates and updates', async () => {
  await newGym('Main Gym');
  error(await request(app).post(gymPath).send({ name: ' MAIN   GYM ' }), 409, 'DUPLICATE_NAME');
  const other = await newGym('Other Gym');
  error(await request(app).patch(`${gymPath}/${other.id}`).send({ name: 'main gym' }), 409, 'DUPLICATE_NAME');
  assert.equal((await request(app).get(`${gymPath}/${other.id}`)).body.data.name, 'Other Gym');
});

test('Branch name uniqueness is per Gym and enforced on updates', async () => {
  const first = await newGym('First Gym');
  const second = await newGym('Second Gym');
  await newBranch(first.id, 'Central Branch');
  await newBranch(second.id, 'Central Branch');
  error(await request(app).post(branchPath(first.id)).send({ name: 'CENTRAL  BRANCH', address }),
    409, 'DUPLICATE_NAME');
  const other = await newBranch(first.id, 'Other Branch');
  error(await request(app).patch(`${branchPath(first.id)}/${other.id}`).send({ name: 'central branch' }),
    409, 'DUPLICATE_NAME');
});

test('concurrent duplicate creates are protected by real database indexes', async () => {
  const responses = await Promise.all([1, 2].map(() => request(app).post(gymPath).send({ name: 'Race Gym' })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await Gym.countDocuments(), 1);
});

test('bootstrap routes stay disabled by default and in staging/production', async () => {
  for (const [nodeEnv, enabled] of [['development', false], ['test', false], ['staging', true], ['production', true]]) {
    const disabled = createApp({ config: { ...config, nodeEnv, enableBootstrapRoutes: enabled }, database });
    error(await request(disabled).get(gymPath), 404, 'NOT_FOUND');
    error(await request(disabled).post(gymPath).send({ name: 'Forbidden Gym' }), 404, 'NOT_FOUND');
  }
  assert.equal(await Gym.countDocuments(), 0);
});

test('no deletion routes exist', async () => {
  const gym = await newGym();
  const branch = await newBranch(gym.id);
  error(await request(app).delete(`${gymPath}/${gym.id}`), 404, 'NOT_FOUND');
  error(await request(app).delete(`${branchPath(gym.id)}/${branch.id}`), 404, 'NOT_FOUND');
});

test('bootstrap startup creates missing indexes before serving HTTP', async () => {
  await Promise.all([Gym.collection.dropIndexes(), Branch.collection.dropIndexes()]);
  const lifecycle = await startServer({ config: { ...config, port: 0, bootstrapPort: 0 }, database });
  try {
    const gymIndexes = await Gym.listIndexes();
    const branchIndexes = await Branch.listIndexes();
    assert.ok(gymIndexes.some((index) => index.name === 'gym_name_unique' && index.unique));
    assert.ok(branchIndexes.some((index) => index.name === 'branch_gym_name_unique' && index.unique));
    assert.equal((await request(lifecycle.bootstrapServer).get(gymPath)).status, 200);
  } finally {
    await lifecycle.shutdown('test');
  }
});
