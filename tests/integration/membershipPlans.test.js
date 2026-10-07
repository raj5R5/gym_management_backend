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
const { createApp, createBootstrapApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createPlanService } = require('../../src/modules/membershipPlans/plan.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/membership-plans`;
const input = (overrides = {}) => ({ name: 'Monthly', durationDays: 30, price: 150000, ...overrides });
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
  return createPlanService({ ...models, authorizationService: createAuthorizationService(models) });
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

test('admin creates a plan with integer-paise price, normalized name and safe DTO', async () => {
  const data = await create(await login(), { name: '  Ｍonthly   Plus ', description: ' General access ' });
  assert.equal(data.name, 'Monthly Plus'); assert.equal(data.price, 150000); assert.equal(data.durationDays, 30);
  assert.equal(data.status, 'active'); assert.equal(data.description, 'General access');
  assert.equal(data.gymId, String(gymA._id)); assert.ok(data.createdAt && data.updatedAt);
  assert.equal('normalizedName' in data, false); assert.equal('__v' in data, false);
  assert.equal((await models.MembershipPlan.findById(data.id).select('+normalizedName')).normalizedName, 'monthly plus');
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.MemberProfile.countDocuments(), 0);
});

test('all plan operations require authentication', async () => {
  for (const [method, url, body] of [['post', path(), input()], ['get', path()],
    ['get', `${path()}/${missingId()}`], ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('only admin can create/update; members cannot list or get plans', async () => {
  const data = await create(await login());
  for (const account of [trainer, member]) {
    const token = await login(account);
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    error(await send('patch', `${path()}/${data.id}`, token, { price: 200000 }), 403, 'FORBIDDEN');
    if (account === member) {
      error(await send('get', path(), token), 403, 'FORBIDDEN');
      error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
    }
  }
});

test('admin and trainer can read active and inactive plans', async () => {
  const data = await create(await login(), { status: 'inactive' });
  for (const account of [admin, trainer]) {
    const token = await login(account);
    const retrieved = await send('get', `${path()}/${data.id}`, token);
    assert.equal(retrieved.status, 200); assert.deepEqual(retrieved.body.data, data);
    assert.equal(retrieved.headers['cache-control'], 'no-store');
    const listed = await send('get', path(), token);
    assert.equal(listed.status, 200); assert.deepEqual(listed.body.data, [data]);
  }
});

test('inactive/suspended/removed access and inactive gyms deny all plan operations', async () => {
  const token = await login(); const data = await create(token);
  async function denied() {
    for (const [method, url, body] of [['post', path(), input()], ['get', path()],
      ['get', `${path()}/${data.id}`], ['patch', `${path()}/${data.id}`, { status: 'inactive' }]]) {
      error(await send(method, url, token, body), 403, 'FORBIDDEN');
    }
  }
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } }); await denied();
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } }); await denied();
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'active' } });
  await models.GymAccess.deleteMany({ userId: admin._id }); await denied();
});

test('normalized plan name uniqueness handles case, whitespace, Unicode and concurrent creation', async () => {
  const token = await login();
  const results = await Promise.all(['Monthly', ' monthly '].map((name) => send('post', path(), token, input({ name }))));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'DUPLICATE_PLAN_NAME');
  for (const name of ['MONTHLY', 'Ｍonthly']) error(await send('post', path(), token, input({ name })), 409, 'DUPLICATE_PLAN_NAME');
  await create(token, { name: 'Monthly Plus' });
  error(await send('post', path(), token, input({ name: 'monthly \t plus' })), 409, 'DUPLICATE_PLAN_NAME');
});

test('same plan name may exist in another gym while cross-gym requests remain isolated', async () => {
  const token = await login(); const own = await create(token);
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  error(await send('get', path({ _id: missingId() }), token), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, {}, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'PLAN_NOT_FOUND');
  error(await send('patch', `${path()}/${foreign.id}`, token, { price: 1 }), 404, 'PLAN_NOT_FOUND');
  assert.equal((await models.MembershipPlan.findById(foreign.id)).price, 150000);
  const list = await send('get', path(), token);
  assert.deepEqual(list.body.data, [own]); assert.equal(list.body.meta.pagination.total, 1);
});

test('admin can update name, duration, price and description without changing identity or omitted fields', async () => {
  const token = await login(); const data = await create(token);
  const response = await send('patch', `${path()}/${data.id}`, token,
    { name: '  Quarterly  Plus ', durationDays: 90, price: 400000, description: 'Extended access' });
  assert.equal(response.status, 200); assert.equal(response.body.data.id, data.id);
  assert.equal(response.body.data.name, 'Quarterly Plus'); assert.equal(response.body.data.durationDays, 90);
  assert.equal(response.body.data.price, 400000); assert.equal(response.body.data.status, 'active');
  assert.equal((await models.MembershipPlan.findById(data.id).select('+normalizedName')).normalizedName, 'quarterly plus');
  await create(token); // Renaming releases the previous name in this gym.
  const cleared = await send('patch', `${path()}/${data.id}`, token, { description: null });
  assert.equal(cleared.status, 200); assert.equal(cleared.body.data.description, undefined);
  assert.equal(cleared.body.data.durationDays, 90);
});

test('duplicate renamed plan is a safe conflict and leaves the original plan intact', async () => {
  const token = await login(); await create(token);
  const second = await create(token, { name: 'Annual' });
  error(await send('patch', `${path()}/${second.id}`, token, { name: ' monthly ' }), 409, 'DUPLICATE_PLAN_NAME');
  assert.equal((await models.MembershipPlan.findById(second.id)).name, 'Annual');
});

test('money requires exact bounded integer minor units on create and PATCH', async () => {
  const token = await login(); const data = await create(token);
  for (const price of [-1, 0.1, 150000.01, 1_000_000_001, Number.MAX_SAFE_INTEGER, '150000', null, {}, [100]]) {
    error(await send('post', path(), token, input({ price })), 400, 'VALIDATION_ERROR');
    error(await send('patch', `${path()}/${data.id}`, token, { price }), 400, 'VALIDATION_ERROR');
  }
  for (const price of [0, 1, 1_000_000_000]) {
    const response = await send('patch', `${path()}/${data.id}`, token, { price });
    assert.equal(response.status, 200); assert.equal(response.body.data.price, price);
    assert.equal((await models.MembershipPlan.findById(data.id)).price, price);
  }
});

test('NaN and Infinity are rejected by service validation and Mongoose validators', async () => {
  await login(); const { auth, authorization } = await context();
  for (const price of [NaN, Infinity, -Infinity, 0.01, -1]) {
    await assert.rejects(service().create(auth, authorization, input({ price })), { code: 'VALIDATION_ERROR' });
    await assert.rejects(models.MembershipPlan.create(input({ gymId: gymA._id, price })), { name: 'ValidationError' });
  }
  assert.equal(await models.MembershipPlan.countDocuments(), 0);
});

test('durations require a positive bounded integer on creation and update', async () => {
  const token = await login(); const data = await create(token);
  for (const durationDays of [0, -1, 1.5, 3651, '30', null]) {
    error(await send('post', path(), token, input({ durationDays })), 400, 'VALIDATION_ERROR');
    error(await send('patch', `${path()}/${data.id}`, token, { durationDays }), 400, 'VALIDATION_ERROR');
  }
  for (const durationDays of [1, 3650]) assert.equal((await send('patch', `${path()}/${data.id}`, token, { durationDays })).status, 200);
});

test('name, description and status validation rejects invalid or oversized input', async () => {
  const token = await login(); const data = await create(token);
  for (const fields of [{ name: '' }, { name: ' \t ' }, { name: 'x'.repeat(121) }, { description: '' },
    { description: 'x'.repeat(2001) }, { status: 'suspended' }, { status: null }]) {
    error(await send('post', path(), token, input(fields)), 400, 'VALIDATION_ERROR');
    error(await send('patch', `${path()}/${data.id}`, token, fields), 400, 'VALIDATION_ERROR');
  }
  error(await send('post', path(), token, {}), 400, 'VALIDATION_ERROR');
  error(await send('patch', `${path()}/${data.id}`, token, {}), 400, 'VALIDATION_ERROR');
});

test('client identity, tenant, normalized fields and future-domain fields are rejected', async () => {
  const token = await login(); const data = await create(token);
  for (const fields of [{ gymId: String(gymB._id) }, { userId: String(admin._id) }, { role: 'admin' },
    { normalizedName: 'chosen' }, { _id: missingId() }, { planId: missingId() }, { createdAt: new Date().toISOString() },
    { updatedAt: new Date().toISOString() }, { memberId: missingId() }, { currency: 'USD' }, { discount: 100 },
    { subscriptionStart: '2025-01-01' }, { paymentId: missingId() }, { $set: { price: 1 } }]) {
    error(await send('post', path(), token, input(fields)), 400, 'VALIDATION_ERROR');
    error(await send('patch', `${path()}/${data.id}`, token, fields), 400, 'VALIDATION_ERROR');
  }
  await models.MembershipPlan.findOneAndUpdate({ _id: data.id }, { $set: { gymId: gymB._id } });
  assert.equal(String((await models.MembershipPlan.findById(data.id)).gymId), String(gymA._id));
});

test('inactive lifecycle retains plans and names and repeated deactivation is safe', async () => {
  const token = await login(); const data = await create(token);
  for (let i = 0; i < 2; i += 1) {
    const result = await send('patch', `${path()}/${data.id}`, token, { status: 'inactive' });
    assert.equal(result.status, 200); assert.equal(result.body.data.status, 'inactive');
  }
  assert.equal(await models.MembershipPlan.countDocuments(), 1);
  error(await send('post', path(), token, input()), 409, 'DUPLICATE_PLAN_NAME');
  assert.equal((await send('patch', `${path()}/${data.id}`, token, { status: 'active' })).status, 200);
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  assert.equal(await models.MembershipPlan.countDocuments(), 1);
});

test('lists use stable bounded pagination, status filtering and literal name search', async () => {
  const token = await login();
  for (const [name, status] of [['Monthly', 'active'], ['Quarterly (Plus)', 'inactive'], ['Annual', 'active']]) await create(token, { name, status });
  const first = await send('get', `${path()}?page=1&limit=2`, token);
  const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 });
  assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filtered = await send('get', `${path()}?status=inactive&search=quarterly`, token);
  assert.equal(filtered.body.meta.pagination.total, 1); assert.equal(filtered.body.data[0].name, 'Quarterly (Plus)');
  assert.equal((await send('get', `${path()}?search=${encodeURIComponent('(Plus)')}`, token)).body.data.length, 1);
  assert.equal((await send('get', `${path()}?search=${encodeURIComponent('.*')}`, token)).body.data.length, 0);
});

test('malformed identifiers, missing resources and unsafe list inputs use standard errors', async () => {
  const token = await login();
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'PLAN_NOT_FOUND');
  error(await send('patch', `${path()}/${missingId()}`, token, { status: 'inactive' }), 404, 'PLAN_NOT_FOUND');
  for (const suffix of ['search[$ne]=x', 'status[$ne]=x', '$where=true', 'gymId=x', 'role=admin',
    'page=0', 'page=1.5', 'page=10001', 'limit=101', 'search=', 'search=x&search=y', `search=${'x'.repeat(101)}`]) {
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  }
});

test('plan routes remain protected on bootstrap and have no alternate route', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', '/api/v1/membership-plans', await login())).status, 404);
});

test('service calls reject missing or stale authorization context', async () => {
  const token = await login(); const data = await create(token); const { auth, authorization } = await context();
  const operations = [(scope) => service().create(auth, scope, input()), (scope) => service().get(auth, scope, data.id),
    (scope) => service().list(auth, scope, { page: 1, limit: 20 }),
    (scope) => service().update(auth, scope, data.id, { status: 'inactive' })];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
  assert.equal((await models.MembershipPlan.findById(data.id)).status, 'active');
});

test('database failures fail closed and expose no internal details', async (t) => {
  const token = await login(); const data = await create(token);
  for (const [model, method, verb, url, body] of [
    [models.GymAccess, 'findOne', 'post', path(), input()], [models.Gym, 'findOne', 'post', path(), input()],
    [models.MembershipPlan, 'create', 'post', path(), input()],
    [models.MembershipPlan, 'findOne', 'get', `${path()}/${data.id}`],
    [models.MembershipPlan, 'find', 'get', path()], [models.MembershipPlan, 'countDocuments', 'get', path()],
    [models.MembershipPlan, 'findOneAndUpdate', 'patch', `${path()}/${data.id}`, { status: 'inactive' }],
  ]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database details'); });
    const response = await send(verb, url, token, body);
    error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
    mocked.mock.restore();
  }
  assert.equal((await models.MembershipPlan.findById(data.id)).status, 'active');
});

test('role denials never reach plan controllers', async () => {
  const express = require('express');
  const { createPlanRouter } = require('../../src/modules/membershipPlans/plan.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  let calls = 0;
  const denied = async () => { calls += 1; throw new Error('Controller reached'); };
  const protectedApp = express(); protectedApp.use(requestId); protectedApp.use(express.json());
  protectedApp.use('/api/v1/gyms/:gymId/membership-plans', createPlanRouter({ create: denied, list: denied, get: denied, update: denied },
    createAuthService({ ...models, config }), createAuthorizationMiddleware(createAuthorizationService(models))));
  protectedApp.use(errorHandler);
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [method, url, body] of [['post', path(), input()], ['patch', `${path()}/${missingId()}`, { status: 'inactive' }],
      ...(account === member ? [['get', path()], ['get', `${path()}/${missingId()}`]] : [])]) {
      const pending = request(protectedApp)[method](url).set('Authorization', `Bearer ${token}`);
      if (body) pending.send(body);
      error(await pending, 403, 'FORBIDDEN');
    }
  }
  assert.equal(calls, 0);
});

test('startup creates plan uniqueness without dropping unrelated indexes', async () => {
  await models.MembershipPlan.collection.dropIndexes();
  await models.MembershipPlan.collection.createIndex({ price: 1 }, { name: 'retained_plan_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.MembershipPlan.listIndexes();
    assert.ok(indexes.some((index) => index.name === 'plan_gym_name_unique' && index.unique));
    assert.ok(indexes.some((index) => index.name === 'retained_plan_index'));
  } finally { await lifecycle.shutdown('test'); }
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
