const { testAuthEnv } = require('../helpers/authConfig');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { loadConfig } = require('../../src/config/env');
const { createApp: createRuntimeApp, createBootstrapApp } = require('../../src/app');
const { historicalRecords } = require('../helpers/historicalRecords');
const createApp = (options) => { const app = createRuntimeApp(options); historicalRecords(options.database?.connection); return app; };
const { createLogger } = require('../../src/config/logger');
const { createDatabase } = require('../../src/config/database');
const { startServer } = require('../../src/server');

let isolated;
let database;
let config;
let app;
let Gym;
const missingId = () => String(new mongoose.Types.ObjectId());
const gymPath = '/api/v1/gyms';

before(async () => {
  isolated = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri,
    ENABLE_BOOTSTRAP_ROUTES: 'true' });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  app = createBootstrapApp({ config, database });
  ({ Gym } = database.connection.models);
  // Indexes are real MongoDB constraints, not mocked uniqueness checks.
  await Promise.all([Gym.createIndexes()]);
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  app = createBootstrapApp({ config, database });
  await Promise.all([Gym.deleteMany({})]);
});

async function newGym(name = 'Main Gym') {
  const response = await request(app).post(gymPath).send({ name });
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



test('invalid Gym IDs return validation errors', async () => {
  error(await request(app).get(gymPath + '/invalid'), 400, 'VALIDATION_ERROR');
});

test('missing Gym cannot be retrieved or updated', async () => {
  const id = missingId();
  error(await request(app).get(gymPath + '/' + id), 404, 'GYM_NOT_FOUND');
  error(await request(app).patch(gymPath + '/' + id).send({name: 'Valid Name'}), 404, 'GYM_NOT_FOUND');
});





test('Gym name uniqueness is case/whitespace insensitive on creates and updates', async () => {
  await newGym('Main Gym');
  error(await request(app).post(gymPath).send({ name: ' MAIN   GYM ' }), 409, 'DUPLICATE_NAME');
  const other = await newGym('Other Gym');
  error(await request(app).patch(`${gymPath}/${other.id}`).send({ name: 'main gym' }), 409, 'DUPLICATE_NAME');
  assert.equal((await request(app).get(`${gymPath}/${other.id}`)).body.data.name, 'Other Gym');
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

test('no gym deletion or retired branch routes exist', async () => {
  const gym = await newGym();
  error(await request(app).delete(gymPath + '/' + gym.id), 404, 'NOT_FOUND');
  error(await request(app).post(gymPath + '/' + gym.id + '/branches').send({}), 404, 'NOT_FOUND');
});

test('bootstrap startup creates required gym indexes before serving HTTP', async () => {
  await Gym.collection.dropIndexes(); // isolated test database only
  const lifecycle = await startServer({ config: { ...config, port: 0, bootstrapPort: 0 }, database });
  try { assert.ok((await Gym.listIndexes()).some(index => index.unique && index.key.nameKey)); }
  finally { await lifecycle.shutdown('test'); }
});
