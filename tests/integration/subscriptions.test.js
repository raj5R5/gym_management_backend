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
const { createSubscriptionService } = require('../../src/modules/subscriptions/subscription.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
const day = (offset = 0) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };
const input = (overrides = {}) => ({ memberId: String(memberA._id), membershipPlanId: String(planA._id), startDate: day(), ...overrides });
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
  return createSubscriptionService({ ...models, authorizationService: createAuthorizationService(models) });
}
async function context() {
  const auth = { user: admin, session: await models.AuthSession.findOne({ userId: admin._id }).lean() };
  const authorization = await createAuthorizationService(models).requireGymAccess(auth, String(gymA._id));
  return { auth, authorization };
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});

test('admin creates immutable plan snapshots, integer paise and a server-derived exclusive end date', async () => {
  const data = await create(await login(), { notes: ' Initial purchase ' });
  assert.equal(data.gymId, String(gymA._id)); assert.equal(data.memberId, String(memberA._id));
  assert.equal(data.membershipPlanId, String(planA._id)); assert.equal(data.startDate, day()); assert.equal(data.endDate, day(30));
  assert.equal(data.planNameSnapshot, 'Monthly'); assert.equal(data.durationDaysSnapshot, 30); assert.equal(data.pricePaiseSnapshot, 150000);
  assert.equal(data.status, 'active'); assert.equal(data.notes, 'Initial purchase'); assert.ok(data.createdAt && data.updatedAt);
  for (const field of ['role', 'userId', 'passwordHash', 'branchId', '__v']) assert.equal(field in data, false);
  assert.equal(await models.UserAccount.countDocuments(), 3);
});

test('later plan edits and deactivation never rewrite subscription history or validity', async () => {
  const token = await login(); const data = await create(token);
  await models.MembershipPlan.findOneAndUpdate({ _id: planA._id }, { $set: { name: 'Annual', normalizedName: 'annual', durationDays: 365, price: 180000, status: 'inactive' } });
  const result = await send('get', `${path()}/${data.id}`, token);
  assert.equal(result.status, 200); assert.deepEqual(result.body.data, data);
  assert.equal((await send('get', path(), token)).body.data[0].pricePaiseSnapshot, 150000);
});

test('every operation requires authentication', async () => {
  for (const [verb, url, body] of [['post', path(), input()], ['get', path()], ['get', `${path()}/${missingId()}`],
    ['patch', `${path()}/${missingId()}/cancel`, {}]]) {
    error(await send(verb, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('trainers cannot create/cancel and members cannot manage or read subscriptions', async () => {
  const data = await create(await login());
  for (const account of [trainer, member]) {
    const token = await login(account);
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    error(await send('patch', `${path()}/${data.id}/cancel`, token, {}), 403, 'FORBIDDEN');
    if (account === member) {
      error(await send('get', path(), token), 403, 'FORBIDDEN');
      error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
    }
  }
});

test('inactive/suspended gym access and inactive gyms deny creation and reads', async () => {
  const token = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } });
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    error(await send('get', path(), token), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
});

test('missing/foreign members and plans are rejected, with no cross-gym writes', async () => {
  const token = await login();
  for (const memberId of [missingId(), String(memberB._id)]) error(await send('post', path(), token, input({ memberId })), 404, 'MEMBER_NOT_FOUND');
  for (const membershipPlanId of [missingId(), String(planB._id)]) error(await send('post', path(), token, input({ membershipPlanId })), 404, 'PLAN_NOT_FOUND');
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  error(await send('post', path({ _id: missingId() }), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.MemberSubscription.countDocuments(), 0);
  assert.equal((await models.MemberProfile.findById(memberA._id)).__v, 0); // Aborted transactions restore serialization writes.
});

test('inactive plans and inactive/suspended members cannot create subscriptions', async () => {
  const token = await login();
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { status: 'inactive' } });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { status: 'active' } });
  for (const status of ['inactive', 'suspended']) {
    await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { status } });
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  }
  assert.equal(await models.MemberSubscription.countDocuments(), 0);
});

test('overlapping ranges are rejected while adjacent and separate historical periods are allowed', async () => {
  const token = await login(); await create(token, { startDate: day(-60) });
  for (const startDate of [day(-60), day(-59), day(-31)]) {
    error(await send('post', path(), token, input({ startDate })), 409, 'SUBSCRIPTION_OVERLAP');
  }
  await create(token, { startDate: day(-30) }); await create(token);
  assert.equal(await models.MemberSubscription.countDocuments(), 3);
});

test('concurrent requests cannot create overlapping subscriptions even through different service instances', async () => {
  const token = await login();
  const responses = await Promise.all([send('post', path(), token, input()), send('post', path(), token, input({ startDate: day(-1) }))]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [201, 409]);
  error(responses.find((value) => value.status === 409), 409, 'ACTIVE_MEMBERSHIP_EXISTS');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('calendar dates handle leap days and UTC boundaries deterministically', async () => {
  const token = await login();
  const data = await create(token, { startDate: '2024-02-01' });
  assert.equal(data.endDate, '2024-03-02'); assert.equal(data.status, 'expired');
  const another = await create(token, { memberId: String(memberOther._id), startDate: '2023-12-31' });
  assert.equal(another.endDate, '2024-01-30');
  assert.equal((await models.MemberSubscription.findById(data.id)).startDate.toISOString(), '2024-02-01T00:00:00.000Z');
});

test('expiration is effective at the exclusive end date and GET performs no lifecycle writes', async (t) => {
  const token = await login(); const data = await create(token, { startDate: day(-30) });
  assert.equal(data.endDate, day()); assert.equal(data.status, 'expired');
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { status: 'active' } });
  const before = await models.MemberSubscription.findById(data.id).lean();
  t.mock.method(models.MemberSubscription, 'updateMany', () => { throw new Error('GET must not mutate'); });
  assert.equal((await send('get', `${path()}/${data.id}`, token)).body.data.status, 'expired');
  assert.equal((await send('get', `${path()}?status=active`, token)).body.data.length, 0);
  assert.equal((await send('get', `${path()}?status=expired`, token)).body.meta.pagination.total, 1);
  assert.deepEqual(await models.MemberSubscription.findById(data.id).lean(), before);
});

test('admin cancellation preserves snapshots/dates and concurrent/repeated calls preserve audit fields', async () => {
  const token = await login(); const data = await create(token);
  const responses = await Promise.all([send('patch', `${path()}/${data.id}/cancel`, token, { cancellationReason: 'Requested' }),
    send('patch', `${path()}/${data.id}/cancel`, token, { cancellationReason: 'Other' })]);
  for (const result of responses) { assert.equal(result.status, 200); assert.equal(result.body.data.status, 'cancelled'); }
  assert.equal(responses[0].body.data.cancelledAt, responses[1].body.data.cancelledAt);
  assert.equal(responses[0].body.data.cancellationReason, responses[1].body.data.cancellationReason);
  const repeated = await send('patch', `${path()}/${data.id}/cancel`, token);
  assert.deepEqual(repeated.body.data, responses[0].body.data);
  for (const field of ['memberId', 'membershipPlanId', 'startDate', 'endDate', 'planNameSnapshot', 'durationDaysSnapshot', 'pricePaiseSnapshot'])
    assert.equal(repeated.body.data[field], data[field]);
  await create(token); assert.equal(await models.MemberSubscription.countDocuments(), 2);
});

test('trainer lists/gets only actively assigned members and filters cannot expand scope', async () => {
  const adminToken = await login(); const own = await create(adminToken);
  const unrelated = await create(adminToken, { memberId: String(memberOther._id) });
  const token = await login(trainer);
  assert.deepEqual((await send('get', path(), token)).body.data, [own]);
  assert.equal((await send('get', `${path()}/${own.id}`, token)).status, 200);
  error(await send('get', `${path()}/${unrelated.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
  const filtered = await send('get', `${path()}?memberId=${memberOther._id}&limit=100&page=1`, token);
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.data, []); assert.equal(filtered.body.meta.pagination.total, 0);
  error(await send('get', `${path()}?trainerId=${trainerA._id}`, token), 400, 'VALIDATION_ERROR');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive', endedAt: new Date() } });
  assert.equal((await send('get', path(), token)).body.data.length, 0);
  error(await send('get', `${path()}/${own.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
});

test('unlinked/inactive/suspended/ambiguous trainers fail closed', async () => {
  const token = await login(trainer);
  for (const status of ['inactive', 'suspended']) {
    await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status } });
    error(await send('get', path(), token), 403, 'FORBIDDEN');
  }
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'active' } });
  await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', userId: trainer._id, firstName: 'Pat', lastName: 'Smith', phone: '9876543211' });
  error(await send('get', path(), token), 403, 'FORBIDDEN');
  await models.TrainerProfile.collection.updateMany({ userId: trainer._id }, { $unset: { userId: '' } });
  error(await send('get', path(), token), 403, 'FORBIDDEN');
});

test('cross-gym subscription IDs, plans and assignments cannot bypass read/cancel isolation', async () => {
  const token = await login(); await create(token);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('patch', `${path()}/${foreign.id}/cancel`, token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 1);
  const trainerToken = await login(trainer);
  error(await send('get', `${path()}/${foreign.id}`, trainerToken), 404, 'SUBSCRIPTION_NOT_FOUND');
});

test('pagination and member/plan/effective-status filters remain bounded and consistent', async () => {
  const token = await login(); const old = await create(token, { startDate: day(-30) }); await create(token);
  const third = await create(token, { memberId: String(memberOther._id) });
  await send('patch', `${path()}/${third.id}/cancel`, token, {});
  const first = await send('get', `${path()}?page=1&limit=2`, token); const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 }); assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filtered = await send('get', `${path()}?status=expired&memberId=${memberA._id}&membershipPlanId=${planA._id}`, token);
  assert.deepEqual(filtered.body.data.map((value) => value.id), [old.id]);
  assert.equal((await send('get', `${path()}?status=cancelled`, token)).body.meta.pagination.total, 1);
});

test('strict creation rejects commercial terms, authorization fields, invalid IDs/dates and oversized notes', async () => {
  const token = await login();
  for (const fields of [{ pricePaiseSnapshot: 1 }, { durationDaysSnapshot: 1 }, { planNameSnapshot: 'Chosen' },
    { endDate: day(1) }, { status: 'active' }, { gymId: String(gymB._id) }, { userId: String(member._id) },
    { role: 'admin' }, { permissions: ['all'] }, { trainerId: String(trainerA._id) }, { memberId: 'invalid' },
    { membershipPlanId: 'invalid' }, { startDate: '2024-02-30' }, { startDate: '2023-02-29' }, { startDate: day(1) },
    { startDate: '0000-01-01' }, { startDate: '2024-01-01T00:00:00Z' }, { startDate: 'bad' },
    { notes: '' }, { notes: 'x'.repeat(2001) }, { createdAt: new Date().toISOString() }, { $set: { pricePaiseSnapshot: 0 } }]) {
    error(await send('post', path(), token, input(fields)), 400, 'VALIDATION_ERROR');
  }
  error(await send('post', path(), token, {}), 400, 'VALIDATION_ERROR');
  assert.equal(await models.MemberSubscription.countDocuments(), 0);
});

test('cancellation rejects protected term changes and only accepts a bounded optional reason', async () => {
  const token = await login(); const data = await create(token);
  for (const fields of [{ status: 'cancelled' }, { startDate: day(-1) }, { endDate: day() }, { memberId: missingId() },
    { membershipPlanId: missingId() }, { pricePaiseSnapshot: 1 }, { durationDaysSnapshot: 1 }, { planNameSnapshot: 'Changed' },
    { gymId: missingId() }, { userId: missingId() }, { cancellationReason: '' }, { cancellationReason: 'x'.repeat(501) },
    { cancelledAt: new Date().toISOString() }, { $set: { status: 'cancelled' } }]) {
    error(await send('patch', `${path()}/${data.id}/cancel`, token, fields), 400, 'VALIDATION_ERROR');
  }
  error(await send('patch', `${path()}/${data.id}`, token, { status: 'cancelled' }), 404, 'NOT_FOUND');
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  assert.equal((await models.MemberSubscription.findById(data.id)).status, 'active');
});

test('unsafe query operators, arbitrary filters, malformed IDs and pagination fail validation', async () => {
  const token = await login();
  for (const suffix of ['memberId[$ne]=x', 'membershipPlanId[$ne]=x', 'status[$ne]=x', '$where=true', 'gymId=x',
    'userId=x', 'role=admin', 'memberId=x', 'membershipPlanId=x', 'page=0', 'page=1.5', 'page=10001',
    'limit=101', 'status=unknown', 'memberId=x&memberId=y']) error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
});

test('subscription routes remain authenticated on bootstrap and have no alternate route', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', '/api/v1/subscriptions', await login())).status, 404);
});

test('failed database writes roll back serialization and expose no credentials', async (t) => {
  const token = await login();
  t.mock.method(models.MemberSubscription, 'create', () => { throw new Error('private database details'); });
  const response = await send('post', path(), token, input()); error(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.equal((await models.MemberProfile.findById(memberA._id)).__v, 0); assert.equal(await models.MemberSubscription.countDocuments(), 0);
});

test('database authorization, profile, plan, overlap and read failures fail closed', async (t) => {
  const token = await login(); const data = await create(token);
  for (const [model, method, verb, url, body] of [
    [models.GymAccess, 'findOne', 'post', path(), input()], [models.Gym, 'findOne', 'post', path(), input()],
    [models.MemberProfile, 'findOneAndUpdate', 'post', path(), input()], [models.MembershipPlan, 'findOne', 'post', path(), input()],
    [models.MemberSubscription, 'exists', 'post', path(), input()], [models.MemberSubscription, 'aggregate', 'get', path()],
    [models.MemberSubscription, 'findOneAndUpdate', 'patch', `${path()}/${data.id}/cancel`, {}],
  ]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database details'); });
    const result = await send(verb, url, token, body); error(result, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(JSON.stringify(result.body).includes('private'), false); mocked.mock.restore();
  }
});

test('direct service calls reject stale or missing gym authorization', async () => {
  const token = await login(); const data = await create(token); const { auth, authorization } = await context();
  const calls = [(scope) => service().create(auth, scope, input()), (scope) => service().get(auth, scope, data.id),
    (scope) => service().list(auth, scope, { page: 1, limit: 20 }), (scope) => service().cancel(auth, scope, data.id, {})];
  for (const call of calls) await assert.rejects(call(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  for (const call of calls) await assert.rejects(call(authorization), { code: 'FORBIDDEN' });
});

test('startup adds subscription indexes without dropping unrelated indexes', async () => {
  await models.MemberSubscription.collection.dropIndexes();
  await models.MemberSubscription.collection.createIndex({ notes: 1 }, { name: 'retained_subscription_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.MemberSubscription.listIndexes();
    assert.ok(indexes.some((value) => value.name === 'subscription_member_period'));
    assert.ok(indexes.some((value) => value.name === 'retained_subscription_index'));
    assert.equal(indexes.some((value) => value.unique), false);
  } finally { await lifecycle.shutdown('test'); }
});

test('model query updates preserve every immutable subscription term', async () => {
  const token = await login(); const data = await create(token);
  await models.MemberSubscription.findOneAndUpdate({ _id: data.id }, { $set: {
    gymId: gymB._id, memberId: memberOther._id, membershipPlanId: planB._id, startDate: new Date('2020-01-01'),
    endDate: new Date('2020-02-01'), planNameSnapshot: 'Changed', durationDaysSnapshot: 1, pricePaiseSnapshot: 1,
  } }, { runValidators: true });
  const preserved = (await send('get', `${path()}/${data.id}`, token)).body.data;
  for (const field of ['id', 'gymId', 'memberId', 'membershipPlanId', 'startDate', 'endDate',
    'planNameSnapshot', 'durationDaysSnapshot', 'pricePaiseSnapshot']) assert.equal(preserved[field], data[field]);
});

test('future existing ranges still participate in overlap checks and corrupt raw terms are never authoritative input', async () => {
  const token = await login();
  await models.MemberSubscription.create({ gymId: gymA._id, memberId: memberA._id, membershipPlanId: planA._id,
    startDate: new Date(`${day(1)}T00:00:00Z`), endDate: new Date(`${day(31)}T00:00:00Z`), status: 'active',
    planNameSnapshot: 'Monthly', durationDaysSnapshot: 30, pricePaiseSnapshot: 150000 });
  error(await send('post', path(), token, input()), 409, 'ACTIVE_MEMBERSHIP_EXISTS');
  const future = await send('get', path(), token);
  assert.equal(future.status, 200); assert.equal(future.body.data[0].isCurrentlyActive, false);
  await models.MembershipPlan.collection.updateOne({ _id: planA._id }, { $set: { price: 0.5 } });
  error(await send('post', path(), token, input({ memberId: String(memberOther._id) })), 400, 'VALIDATION_ERROR');
});

test('corrupt cross-gym reference records are excluded from all read and cancellation paths', async () => {
  const token = await login(); const data = await create(token);
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { membershipPlanId: planB._id } });
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 0);
  error(await send('get', `${path()}/${data.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('patch', `${path()}/${data.id}/cancel`, token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
});

test('role/assignment denials never reach subscription controllers', async () => {
  const express = require('express');
  const { createSubscriptionRouter } = require('../../src/modules/subscriptions/subscription.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  const data = await create(await login(), { memberId: String(memberOther._id) });
  let calls = 0; const denied = async () => { calls += 1; throw new Error('Controller reached'); };
  const guarded = express(); guarded.use(requestId); guarded.use(express.json());
  guarded.use('/api/v1/gyms/:gymId/subscriptions', createSubscriptionRouter({ ...service(),
    create: denied, get: denied, list: denied, cancel: denied }, createAuthService({ ...models, config }),
  createAuthorizationMiddleware(createAuthorizationService(models))));
  guarded.use(errorHandler);
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [verb, url, body] of [['post', path(), input()], ['patch', `${path()}/${data.id}/cancel`, {}],
      ['get', `${path()}/${data.id}`], ...(account === member ? [['get', path()]] : [])]) {
      const pending = request(guarded)[verb](url).set('Authorization', `Bearer ${token}`); if (body) pending.send(body);
      const ownDenial = account === trainer && verb === 'get';
      error(await pending, ownDenial ? 404 : 403, ownDenial ? 'SUBSCRIPTION_NOT_FOUND' : 'FORBIDDEN');
    }
  }
  assert.equal(calls, 0);
});

test('standalone MongoDB rejects subscription creation safely without a nontransactional fallback', async () => {
  const standalone = await startTestMongo(); const localConfig = { ...config, mongoUri: standalone.uri };
  const local = createDatabase({ logger: createLogger(localConfig) });
  try {
    await local.connect(localConfig); createApp({ config: localConfig, database: local });
    const localModels = local.connection.models;
    await Promise.all(Object.values(localModels).map((model) => model.createIndexes()));
    await login(); const { auth, authorization } = await context();
    const standaloneService = createSubscriptionService({ ...localModels, authorizationService: createAuthorizationService(models) });
    await assert.rejects(standaloneService.create(auth, authorization, input()), { code: 'SUBSCRIPTION_STORAGE_UNAVAILABLE' });
    await assert.rejects(standaloneService.renew(auth, authorization, missingId(), {}), { code: 'SUBSCRIPTION_STORAGE_UNAVAILABLE' });
    assert.equal(await localModels.MemberSubscription.countDocuments(), 0);
  } finally { await local.disconnect(); await standalone.stop(); }
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
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME02' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, memberCode: 'ME01' });
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  assignment = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});


test('an unexpired membership blocks direct API creation even for a disjoint historical period', async () => {
  const token = await login(); const first = await create(token);
  const old = await models.MemberSubscription.findById(first.id).lean();
  const profile = await models.MemberProfile.findById(memberA._id).lean();
  error(await send('post', path(), token, input({ startDate: day(-120) })), 409, 'ACTIVE_MEMBERSHIP_EXISTS');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.deepEqual(await models.MemberSubscription.findById(first.id).lean(), old);
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), profile);
});
test('exclusive end reached permits a purchase even when the old membership is entirely unpaid', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-30) });
  assert.equal(first.endDate, day()); assert.equal(first.status, 'expired');
  assert.equal(await models.Payment.countDocuments(), 0);
  const next = await create(token);
  assert.equal(next.isCurrentlyActive, true);
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
  assert.equal((await models.MemberSubscription.findById(first.id)).pricePaiseSnapshot, 150000);
});
test('cancelled membership permits a new purchase while preserving its unpaid history', async () => {
  const token = await login(); const first = await create(token);
  assert.equal((await send('patch', `${path()}/${first.id}/cancel`, token, {})).status, 200);
  await create(token);
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
  const historical = await models.MemberSubscription.findById(first.id).lean();
  assert.equal(historical.status, 'cancelled'); assert.equal(historical.pricePaiseSnapshot, 150000);
  assert.equal(await models.Payment.countDocuments(), 0);
});

test('configured gym calendar controls purchase validation, lifecycle and renewal preview', async () => {
  await login();
  await models.Gym.updateOne({_id: gymA._id}, {'settings.timezone': 'Asia/Kolkata'});
  const auth = {user: admin, session: await models.AuthSession.findOne({userId: admin._id}).lean()};
  const authorizationService = createAuthorizationService(models);
  const selected = await authorizationService.requireGymAccess(auth, String(gymA._id));
  let now = new Date('2026-10-26T19:00:00Z'); // Oct 27 in Kolkata, still Oct 26 UTC
  const service = createSubscriptionService({...models, authorizationService, clock: () => now});
  const record = await service.create(auth, selected, {memberId: String(memberA._id), membershipPlanId: String(planA._id), startDate: '2026-10-27'});
  assert.equal(record.isCurrentlyActive, true);
  assert.equal(record.endDate, '2026-11-26');
  await assert.rejects(service.create(auth, selected, {memberId: String(memberOther._id), membershipPlanId: String(planA._id), startDate: '2026-10-28'}), {code: 'VALIDATION_ERROR'});
  now = new Date('2026-11-25T19:00:00Z'); // exclusive end reached locally
  assert.equal((await service.get(auth, selected, record.id)).status, 'expired');
  const preview = await service.renewalPreview(auth, selected, record.id);
  assert.equal(preview.calendarTimezone, 'Asia/Kolkata');
  assert.equal(preview.terms.startDate, '2026-11-26');
});
