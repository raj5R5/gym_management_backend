const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp: createRuntimeApp, createBootstrapApp } = require('../../src/app');
const { historicalRecords } = require('../helpers/historicalRecords');
const createApp = (options) => { const app = createRuntimeApp(options); historicalRecords(options.database?.connection); return app; };
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createTrainerService } = require('../../src/modules/trainers/trainer.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/trainers`;
const input = (overrides = {}) => ({ trainerCode: 'GYM001', firstName: 'Alex', lastName: 'River', phone: '+91 9876543210', ...overrides });
function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.success, false);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
function send(method, url, token, body) {
  const pending = request(app)[method](url);
  if (token) pending.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) pending.send(body);
  return pending;
}
async function login(account = admin) {
  const response = await request(app).post('/api/v1/auth/login').send({ email: account.email, password, client: 'mobile' });
  assert.equal(response.status, 200);
  return response.body.data.accessToken;
}
async function create(token, overrides = {}, gym = gymA) {
  const response = await send('post', path(gym), token, input(overrides));
  assert.equal(response.status, 201);
  return response.body.data;
}
function service() {
  return createTrainerService({ ...models, authorizationService: createAuthorizationService(models) });
}
async function context() {
  const auth = { user: admin, session: await models.AuthSession.findOne({ userId: admin._id }).lean() };
  const authorization = await createAuthorizationService(models).requireGymAccess(auth, String(gymA._id));
  return { auth, authorization };
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
  app = createApp({ config, database });
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active' });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  for (const [role, assign] of [['admin', (user) => { admin = user; }], ['trainer', (user) => { trainer = user; }],
    ['member', (user) => { member = user; }]]) {
    const user = await models.UserAccount.create({ email: `${role}@example.com`, passwordHash, status: 'active' });
    assign(user);
    await models.GymAccess.create({ userId: user._id, gymId: gymA._id, role, status: 'active' });
  }
});

test('admin creates a standalone trainer with normalized code and no account/grant creation', async () => {
  const token = await login();
  const data = await create(token, { trainerCode: ' gym001 ', dateOfBirth: '1995-06-12',
    gender: 'other', address: { line1: 'Home Road', city: 'City', countryCode: 'IN' },
    specializations: [' Strength ', 'Mobility'] });
  assert.equal(data.trainerCode, 'GYM001'); assert.equal(data.status, 'active');
  assert.equal(data.gymId, String(gymA._id)); assert.equal(data.userId, undefined);
  assert.deepEqual(data.specializations, ['Strength', 'Mobility']);
  assert.equal(data.dateOfBirth, '1995-06-12'); assert.ok(data.createdAt && data.updatedAt);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  for (const field of ['passwordHash', 'email', 'role', 'refreshToken']) assert.equal(field in data, false);
});

test('trainer and member cannot create or update, and unauthorized requests never reach the database operation', async (t) => {
  const token = await login(); const data = await create(token);
  let calls = 0;
  t.mock.method(models.TrainerProfile, 'create', () => { calls += 1; throw new Error('Must not reach create'); });
  t.mock.method(models.TrainerProfile, 'findOneAndUpdate', () => { calls += 1; throw new Error('Must not reach update'); });
  for (const account of [trainer, member]) {
    const denied = await login(account);
    error(await send('post', path(), denied, input()), 403, 'FORBIDDEN');
    error(await send('patch', `${path()}/${data.id}`, denied, { status: 'inactive' }), 403, 'FORBIDDEN');
  }
  assert.equal(calls, 0);
});

test('all trainer operations require authentication', async () => {
  for (const [method, url, body] of [['post', path(), input()], ['get', path()],
    ['get', `${path()}/${missingId()}`], ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('inactive/suspended/removed access and inactive/nonexistent gyms deny trainer operations', async () => {
  const token = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { status } });
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  error(await send('post', path({ _id: missingId() }), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.TrainerProfile.countDocuments(), 0);
});



test('normalized code uniqueness is enforced by MongoDB under concurrent creation within one gym', async () => {
  const token = await login();
  const results = await Promise.all([' gym001 ', 'GYM001'].map((trainerCode) => send('post', path(), token, input({ trainerCode }))));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'DUPLICATE_TRAINER_CODE');
  assert.equal(await models.TrainerProfile.countDocuments(), 1);
});

test('same code in different gyms is allowed and code conflicts do not enumerate other gyms', async () => {
  const token = await login(); await create(token);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const second = await create(token, {}, gymB);
  assert.equal(second.gymId, String(gymB._id)); assert.equal(await models.TrainerProfile.countDocuments(), 2);
});

test('only admins can list and retrieve trainers; both other roles are denied', async () => {
  const adminToken = await login(); const data = await create(adminToken);
  const listed = await send('get', path(), adminToken);
  assert.equal(listed.status, 200); assert.equal(listed.body.data.length, 1);
  const retrieved = await send('get', `${path()}/${data.id}`, adminToken);
  assert.equal(retrieved.status, 200); assert.deepEqual(retrieved.body.data, data);
  assert.equal(retrieved.headers['cache-control'], 'no-store');
  for (const account of [trainer, member]) {
    const token = await login(account);
    error(await send('get', path(), token), 403, 'FORBIDDEN');
    error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
  }
});

test('pagination is bounded and stable and metadata totals respect status and search', async () => {
  const token = await login();
  for (const [trainerCode, status] of [['A01', 'active'], ['A02', 'inactive'], ['A03', 'active']]) await create(token, { trainerCode, status });
  const first = await send('get', `${path()}?page=1&limit=2`, token);
  const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 });
  assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filtered = await send('get', `${path()}?status=inactive&search=a02`, token);
  assert.equal(filtered.body.data[0].trainerCode, 'A02'); assert.equal(filtered.body.meta.pagination.total, 1);
});

test('literal search covers code, names and phone and never acts as regex or query passthrough', async () => {
  const token = await login(); await create(token, { firstName: 'Zoë', lastName: 'River', specializations: ['Mobility'] });
  for (const search of ['gym001', 'zoë', 'river', '987654', 'mobility']) {
    const result = await send('get', `${path()}?search=${encodeURIComponent(search)}`, token);
    assert.equal(result.body.data.length, 1);
  }
  assert.equal((await send('get', `${path()}?search=${encodeURIComponent('.*')}`, token)).body.data.length, 0);
  for (const suffix of ['search[$ne]=x', 'status[$ne]=x', '$where=true', 'limit[$gt]=1', 'page[]=1', 'page=10001', 'gymId=x', 'role=admin', 'search=x&search=y',
    'page=0', 'page=1.5', 'limit=101', 'status=unknown', 'search=', `search=${'x'.repeat(101)}`]) {
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  }
});

test('trainer ID lookup/update always includes gym scope even when actor has access to both gyms', async () => {
  const token = await login(); await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, {}, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'TRAINER_NOT_FOUND');
  error(await send('patch', `${path()}/${foreign.id}`, token, { firstName: 'Changed' }), 404, 'TRAINER_NOT_FOUND');
  assert.equal((await models.TrainerProfile.findById(foreign.id)).firstName, 'Alex');
  assert.equal((await send('get', path(), token)).body.data.length, 0);
});

test('client cannot override user, role, scope or access status and no account is silently linked', async () => {
  const token = await login();
  for (const extra of [{ userId: String(member._id) }, { userId: missingId() }, { role: 'admin' },
    { gymId: String(gymB._id) }, { accessStatus: 'active' }, { password: 'not accepted' }, { email: 'x@example.com' },
    { memberId: missingId() }, { permissions: ['all'] }, { $set: { gymId: String(gymB._id) } }]) {
    error(await send('post', path(), token, input(extra)), 400, 'VALIDATION_ERROR');
  }
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.TrainerProfile.countDocuments(), 0);
});

test('trusted optional account relationship requires an existing account and HTTP never accepts it', async () => {
  await login(); const { auth, authorization } = await context();
  await assert.rejects(service().create(auth, authorization, input(), { linkedUserId: missingId() }),
    { code: 'USER_ACCOUNT_NOT_FOUND' });
  const linked = await service().create(auth, authorization, input(), { linkedUserId: String(member._id) });
  assert.equal(linked.userId, String(member._id));
});

test('admin updates mutable fields, preserves omitted fields and soft lifecycle never changes accounts/access', async () => {
  const token = await login(); const data = await create(token);
  for (const status of ['inactive', 'suspended', 'active']) {
    const response = await send('patch', `${path()}/${data.id}`, token, { status, firstName: 'Updated' });
    assert.equal(response.status, 200); assert.equal(response.body.data.status, status);
    assert.equal(response.body.data.trainerCode, data.trainerCode); assert.equal(response.body.data.lastName, 'River');
  }
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  assert.equal((await models.UserAccount.findById(admin._id)).status, 'active');
});

test('gym, user and trainer code are immutable through PATCH and model query updates', async () => {
  const token = await login(); const data = await create(token);
  for (const patch of [{ gymId: String(gymB._id) }, { userId: String(member._id) }, { trainerCode: 'GYM002' },
    { createdAt: new Date().toISOString() }, { _id: missingId() }, { role: 'member' }, { accessStatus: 'active' },
    { $set: { firstName: 'Changed' } }, { permissions: ['all'] }, {}]) {
    error(await send('patch', `${path()}/${data.id}`, token, patch), 400, 'VALIDATION_ERROR');
  }
  // Mongoose strips immutable changes rather than rejecting this query.
  await models.TrainerProfile.findOneAndUpdate({ _id: data.id },
    { $set: { gymId: gymB._id, userId: member._id, trainerCode: 'CHANGED' } }, { runValidators: true });
  const preserved = await models.TrainerProfile.findById(data.id);
  assert.equal(preserved.trainerCode, data.trainerCode); assert.equal(preserved.userId, undefined);
  assert.equal((await models.TrainerProfile.findById(data.id)).gymId.toString(), String(gymA._id));
});



test('strict input validation rejects bad required fields, dates, contact data and unsupported future fields', async () => {
  const token = await login();
  for (const patch of [{ firstName: '' }, { lastName: ' ' }, { phone: 'abc' }, { phone: '1234' },
    { phone: '+1234567890123456' }, { trainerCode: 'A' }, { trainerCode: 'A B' }, { trainerCode: 'X'.repeat(33) },
    { status: 'deleted' }, { gender: 'invalid' }, { dateOfBirth: '2024-02-30' }, { dateOfBirth: '2999-01-01' },
    { dateOfBirth: '2020-01-01T00:00:00Z' }, { dateOfBirth: 'bad' }, { specializations: [''] }, { specializations: ['Strength', ' strength '] }, { specializations: 'Strength' }, { specializations: Array(11).fill('Strength') }, { specializations: ['x'.repeat(81)] },
    { address: { line1: 'Road', city: 'City', countryCode: 'India' } }, { address: { line1: 'Road', city: 'City', countryCode: 'IN', role: 'admin' } }]) {
    error(await send('post', path(), token, input(patch)), 400, 'VALIDATION_ERROR');
  }
  const data = await create(token);
  error(await send('patch', `${path()}/${data.id}`, token, { status: 'unknown' }), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('post', path({ _id: 'invalid' }), token, input()), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'TRAINER_NOT_FOUND');
});

test('optional fields can be cleared without removing required data', async () => {
  const token = await login(); const data = await create(token, { dateOfBirth: '2000-01-01', gender: 'other',
    specializations: ['Strength'], address: { line1: 'Road', city: 'City', countryCode: 'IN' } });
  const response = await send('patch', `${path()}/${data.id}`, token,
    { dateOfBirth: null, gender: null, specializations: null, address: null });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.specializations, undefined);
  assert.equal(response.body.data.dateOfBirth, undefined); assert.equal(response.body.data.address, undefined);
  error(await send('patch', `${path()}/${data.id}`, token, { firstName: null }), 400, 'VALIDATION_ERROR');
});

test('trainer routes remain protected on the bootstrap listener and no deletion route exists', async () => {
  const token = await login(); const data = await create(token);
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}`, token)).status, 404);
  assert.equal(await models.TrainerProfile.countDocuments(), 1);
});

test('database errors fail safely without exposing details or performing protected writes', async (t) => {
  const token = await login();
  t.mock.method(models.TrainerProfile, 'create', async () => { throw new Error('private database credentials'); });
  const response = await send('post', path(), token, input());
  error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('service rechecks current gym access instead of trusting stale authorization context', async () => {
  await login(); const { auth, authorization } = await context();
  await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { role: 'trainer' } });
  await assert.rejects(service().create(auth, authorization, input()), { code: 'FORBIDDEN' });
  assert.equal(await models.TrainerProfile.countDocuments(), 0);
});

test('startup creates trainer uniqueness indexes without dropping unrelated indexes', async () => {
  await models.TrainerProfile.collection.dropIndexes();
  await models.TrainerProfile.collection.createIndex({ firstName: 1 }, { name: 'retained_trainer_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.TrainerProfile.listIndexes();
    assert.ok(indexes.some((index) => index.name === 'trainer_gym_code_unique' && index.unique));
    assert.ok(indexes.some((index) => index.name === 'retained_trainer_index'));
  } finally { await lifecycle.shutdown('test'); }
});

test('role denials never invoke trainer controllers, independently of service defenses', async () => {
  const express = require('express');
  const { createTrainerRouter } = require('../../src/modules/trainers/trainer.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  let calls = 0;
  const forbiddenCall = async () => { calls += 1; throw new Error('Controller was reached'); };
  const protectedApp = express();
  protectedApp.use(requestId); protectedApp.use(express.json());
  protectedApp.use('/api/v1/gyms/:gymId/trainers', createTrainerRouter({ create: forbiddenCall, list: forbiddenCall,
    get: forbiddenCall, update: forbiddenCall }, createAuthService({ ...models, config }),
  createAuthorizationMiddleware(createAuthorizationService(models))));
  protectedApp.use(errorHandler);
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [method, url, body] of [['post', path(), input()], ['get', path()], ['get', `${path()}/${missingId()}`],
      ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
      const pending = request(protectedApp)[method](url).set('Authorization', `Bearer ${token}`);
      if (body) pending.send(body);
      error(await pending, 403, 'FORBIDDEN');
    }
  }
  assert.equal(calls, 0);
});

test('authorization database failures fail closed before profile writes', async (t) => {
  const token = await login();
  let writes = 0;
  t.mock.method(models.TrainerProfile, 'create', async () => { writes += 1; });
  for (const model of [models.GymAccess, models.Gym]) {
    const mocked = t.mock.method(model, 'findOne', () => { throw new Error('private database details'); });
    const response = await send('post', path(), token, input());
    error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(JSON.stringify(response.body).includes('private'), false);
    mocked.mock.restore();
  }
  assert.equal(writes, 0);
});



test('specializations support replacement, empty lists and literal metacharacters without query injection', async () => {
  const token = await login(); const data = await create(token, { specializations: ['Mobility (advanced)'] });
  const found = await send('get', `${path()}?search=${encodeURIComponent('(advanced)')}`, token);
  assert.equal(found.status, 200); assert.equal(found.body.data.length, 1);
  for (const specializations of [['Strength', 'Balance'], []]) {
    const response = await send('patch', `${path()}/${data.id}`, token, { specializations });
    assert.equal(response.status, 200); assert.deepEqual(response.body.data.specializations, specializations);
  }
  error(await send('patch', `${path()}/${data.id}`, token, { specializations: ['Strength', 'strength'] }),
    400, 'VALIDATION_ERROR');
  await assert.rejects(models.TrainerProfile.create(input({ trainerCode: 'TR003', gymId: gymA._id,
    specializations: ['Strength', 'strength'] })), { name: 'ValidationError' });
  await assert.rejects(models.TrainerProfile.create(input({ trainerCode: 'TR004', gymId: gymA._id,
    specializations: ['x'.repeat(81)] })), { name: 'ValidationError' });
});

test('service entry points reject missing gym scope and stale access on every operation', async () => {
  const token = await login(); const data = await create(token);
  const { auth, authorization } = await context();
  const operations = [
    (scope) => service().create(auth, scope, input({ trainerCode: 'TR002' })),
    (scope) => service().get(auth, scope, data.id),
    (scope) => service().list(auth, scope, { page: 1, limit: 20 }),
    (scope) => service().update(auth, scope, data.id, { status: 'inactive' }),
  ];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.deleteMany({ userId: admin._id });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
  assert.equal(await models.TrainerProfile.countDocuments(), 1);
  assert.equal((await models.TrainerProfile.findById(data.id)).status, 'active');
});

test('legacy branch-bearing record remains readable/editable without branch lookup', async () => {
  const token = await login(); const original = await create(token);
  const legacy = new mongoose.Types.ObjectId();
  await models.TrainerProfile.updateOne({ _id: original.id }, { branchId: legacy });
  const updated = await send('patch', path() + '/' + original.id, token, { firstName: 'Updated' });
  assert.equal(updated.status, 200); assert.equal(updated.body.data.firstName, 'Updated');
  assert.equal(updated.body.data.branchId, undefined);
  assert.equal(String((await models.TrainerProfile.findById(original.id).lean()).branchId), String(legacy));
  assert.equal((await send('get', path() + '/' + original.id, token)).status, 200);
});
