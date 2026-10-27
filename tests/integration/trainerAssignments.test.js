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
const { createAssignmentService } = require('../../src/modules/trainerAssignments/assignment.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, branchA, admin, trainer, member, passwordHash, trainerA, trainerOther, memberA, memberOther, trainerB, memberB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/trainer-assignments`;
const input = (overrides = {}) => ({ trainerId: String(trainerA._id), memberId: String(memberA._id), ...overrides });
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
  return createAssignmentService({ ...models, authorizationService: createAuthorizationService(models) });
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

test('admin creates an active assignment with server timestamps and an explicit DTO', async () => {
  const token = await login(); const data = await create(token);
  assert.equal(data.gymId, String(gymA._id)); assert.equal(data.trainerId, String(trainerA._id));
  assert.equal(data.memberId, String(memberA._id)); assert.equal(data.status, 'active');
  assert.ok(data.assignedAt && data.createdAt && data.updatedAt); assert.equal(data.endedAt, undefined);
  assert.deepEqual(Object.keys(data).sort(), ['id', 'gymId', 'trainerId', 'memberId', 'status', 'assignedAt', 'createdAt', 'updatedAt'].sort());
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
});

test('all assignment operations require authentication', async () => {
  for (const [method, url, body] of [['post', path(), input()], ['get', path()],
    ['get', `${path()}/${missingId()}`], ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('trainer/member cannot create or update and member cannot read assignments', async () => {
  const data = await create(await login());
  for (const account of [trainer, member]) {
    const token = await login(account);
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    error(await send('patch', `${path()}/${data.id}`, token, { status: 'inactive' }), 403, 'FORBIDDEN');
    if (account === member) {
      error(await send('get', path(), token), 403, 'FORBIDDEN');
      error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
    }
  }
});

test('inactive/suspended access and inactive gyms deny all operations', async () => {
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
});

test('missing and foreign trainer/member references are rejected without creating records', async () => {
  const token = await login();
  for (const trainerId of [missingId(), String(trainerB._id)]) {
    error(await send('post', path(), token, input({ trainerId })), 404, 'TRAINER_NOT_FOUND');
  }
  for (const memberId of [missingId(), String(memberB._id)]) {
    error(await send('post', path(), token, input({ memberId })), 404, 'MEMBER_NOT_FOUND');
  }
  error(await send('post', path(), token, input({ trainerId: String(trainerB._id), memberId: String(memberB._id) })),
    404, 'TRAINER_NOT_FOUND');
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  error(await send('post', path({ _id: missingId() }), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 0);
});

test('inactive and suspended trainer/member profiles cannot receive new assignments', async () => {
  const token = await login();
  for (const profile of [trainerA, memberA]) {
    for (const status of ['inactive', 'suspended']) {
      await profile.constructor.updateOne({ _id: profile._id }, { $set: { status } });
      error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    }
    await profile.constructor.updateOne({ _id: profile._id }, { $set: { status: 'active' } });
  }
});

test('different branches in the same gym are allowed and branch changes do not alter assignments', async () => {
  const secondBranch = await models.Branch.create({ gymId: gymA._id, name: 'Second', nameKey: 'second',
    address: { line1: 'Road', city: 'City', countryCode: 'IN' } });
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { branchId: branchA._id } });
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { branchId: secondBranch._id } });
  const token = await login(); const data = await create(token);
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $unset: { branchId: '' } });
  assert.deepEqual((await send('get', `${path()}/${data.id}`, token)).body.data, data);
});

test('partial unique index protects concurrent active assignment creation', async () => {
  const token = await login();
  const responses = await Promise.all([send('post', path(), token, input()), send('post', path(), token, input())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  error(responses.find((response) => response.status === 409), 409, 'DUPLICATE_ACTIVE_ASSIGNMENT');
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 1);
});

test('deactivation preserves history, permits new periods and is idempotent under concurrency', async () => {
  const token = await login(); const data = await create(token);
  const results = await Promise.all([send('patch', `${path()}/${data.id}`, token, { status: 'inactive' }),
    send('patch', `${path()}/${data.id}`, token, { status: 'inactive' })]);
  for (const response of results) { assert.equal(response.status, 200); assert.equal(response.body.data.status, 'inactive'); }
  assert.equal(results[0].body.data.endedAt, results[1].body.data.endedAt);
  const endedAt = results[0].body.data.endedAt;
  assert.ok(Date.parse(endedAt) >= Date.parse(data.assignedAt));
  const next = await create(token); assert.notEqual(next.id, data.id);
  assert.equal((await send('patch', `${path()}/${data.id}`, token, { status: 'inactive' })).body.data.endedAt, endedAt);
  error(await send('patch', `${path()}/${data.id}`, token, { status: 'active' }), 400, 'VALIDATION_ERROR');
  error(await send('post', path(), token, input()), 409, 'DUPLICATE_ACTIVE_ASSIGNMENT');
  await send('patch', `${path()}/${next.id}`, token, { status: 'inactive' });
  await create(token);
  assert.equal(await models.TrainerMemberAssignment.countDocuments({ status: 'inactive' }), 2);
  assert.equal(await models.TrainerMemberAssignment.countDocuments({ status: 'active' }), 1);
  assert.equal(await models.MemberProfile.countDocuments(), 3); assert.equal(await models.TrainerProfile.countDocuments(), 3);
});

test('admin list and individual reads are limited to the authorized gym', async () => {
  const token = await login(); const own = await create(token);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { trainerId: String(trainerB._id), memberId: String(memberB._id) }, gymB);
  const response = await send('get', path(), token);
  assert.equal(response.status, 200); assert.deepEqual(response.body.data, [own]);
  assert.equal(response.body.meta.pagination.total, 1); assert.equal(response.headers['cache-control'], 'no-store');
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'ASSIGNMENT_NOT_FOUND');
  error(await send('patch', `${path()}/${foreign.id}`, token, { status: 'inactive' }), 404, 'ASSIGNMENT_NOT_FOUND');
  assert.equal((await models.TrainerMemberAssignment.findById(foreign.id)).status, 'active');
});

test('trainer reads only own assignments even with hostile trainer filters', async () => {
  const adminToken = await login(); const own = await create(adminToken);
  const other = await create(adminToken, { trainerId: String(trainerOther._id), memberId: String(memberOther._id) });
  const token = await login(trainer);
  const result = await send('get', path(), token);
  assert.deepEqual(result.body.data, [own]); assert.equal(result.body.meta.pagination.total, 1);
  assert.equal((await send('get', `${path()}/${own.id}`, token)).status, 200);
  error(await send('get', `${path()}/${other.id}`, token), 404, 'ASSIGNMENT_NOT_FOUND');
  const filtered = await send('get', `${path()}?trainerId=${trainerOther._id}`, token);
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.data, []); assert.equal(filtered.body.meta.pagination.total, 0);
  assert.equal((await send('get', `${path()}?trainerId=${String(trainerA._id).toUpperCase()}`, token)).body.data.length, 1);
  assert.equal((await send('get', `${path()}?memberId=${memberOther._id}`, token)).body.data.length, 0);
});

test('unlinked, inactive, suspended and ambiguously linked trainers fail closed', async () => {
  const adminToken = await login(); const own = await create(adminToken); const token = await login(trainer);
  async function denied() {
    error(await send('get', path(), token), 403, 'FORBIDDEN');
    error(await send('get', `${path()}/${own.id}`, token), 403, 'FORBIDDEN');
  }
  for (const status of ['inactive', 'suspended']) {
    await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status } }); await denied();
  }
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'active' } });
  // Fixtures use raw writes to simulate pre-existing internal links; HTTP cannot set userId.
  await models.TrainerProfile.collection.updateOne({ _id: trainerOther._id }, { $set: { userId: trainer._id } }); await denied();
  await models.TrainerProfile.collection.updateMany({ gymId: gymA._id }, { $unset: { userId: '' } }); await denied();
});

test('a trainer link in a different gym grants no requested-gym self access', async () => {
  const token = await login(trainer);
  await models.TrainerProfile.collection.updateOne({ _id: trainerA._id }, { $unset: { userId: '' } });
  await models.TrainerProfile.collection.updateOne({ _id: trainerB._id }, { $set: { userId: trainer._id } });
  error(await send('get', path(), token), 403, 'FORBIDDEN');
});

test('list status/profile filters and stable bounded pagination work for admin', async () => {
  const token = await login(); const one = await create(token);
  await create(token, { memberId: String(memberOther._id) });
  await create(token, { trainerId: String(trainerOther._id) });
  await send('patch', `${path()}/${one.id}`, token, { status: 'inactive' });
  const first = await send('get', `${path()}?page=1&limit=2`, token);
  const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 });
  assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filter = await send('get', `${path()}?status=inactive&trainerId=${trainerA._id}&memberId=${memberA._id}`, token);
  assert.deepEqual(filter.body.data.map((value) => value.id), [one.id]); assert.equal(filter.body.meta.pagination.total, 1);
  assert.equal((await send('get', `${path()}?trainerId=${trainerB._id}`, token)).body.data.length, 0);
});

test('strict create and date validation reject mass assignment and unsafe references', async () => {
  const token = await login();
  for (const extra of [{ gymId: String(gymB._id) }, { userId: String(trainer._id) }, { role: 'admin' },
    { status: 'inactive' }, { endedAt: new Date().toISOString() }, { password: 'not accepted' },
    { trainerId: 'invalid' }, { memberId: 'invalid' }, { assignedAt: 'bad' }, { assignedAt: '2024-02-30T00:00:00Z' },
    { assignedAt: '2999-01-01T00:00:00Z' }, { assignedAt: '2024-01-01' }, { permissions: ['all'] },
    { $set: { trainerId: String(trainerOther._id) } }]) {
    error(await send('post', path(), token, input(extra)), 400, 'VALIDATION_ERROR');
  }
  error(await send('post', path(), token, {}), 400, 'VALIDATION_ERROR');
  const data = await create(token, { assignedAt: '2024-01-01T12:30:00+05:30' });
  assert.equal(data.assignedAt, '2024-01-01T07:00:00.000Z');
});

test('PATCH rejects immutable relationships, dates, identity and arbitrary operators', async () => {
  const token = await login(); const data = await create(token);
  for (const patch of [{ gymId: String(gymB._id) }, { trainerId: String(trainerOther._id) }, { memberId: String(memberOther._id) },
    { userId: String(trainer._id) }, { assignedAt: new Date().toISOString() }, { endedAt: new Date().toISOString() },
    { role: 'admin' }, { status: 'suspended' }, { status: 'active' }, { status: null }, {},
    { status: 'inactive', $set: { memberId: String(memberOther._id) } }]) {
    error(await send('patch', `${path()}/${data.id}`, token, patch), 400, 'VALIDATION_ERROR');
  }
  assert.equal((await models.TrainerMemberAssignment.findById(data.id)).status, 'active');
});

test('invalid IDs and unsafe query/filter inputs are rejected', async () => {
  const token = await login();
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'ASSIGNMENT_NOT_FOUND');
  for (const suffix of ['trainerId=x', 'memberId=x', 'trainerId[$ne]=x', 'memberId[$ne]=x', 'status[$ne]=x',
    '$where=true', 'gymId=x', 'userId=x', 'role=admin', 'status=suspended', 'page=0', 'page=1.5', 'page=10001',
    'limit=101', 'limit[]=1', 'trainerId=x&trainerId=y', 'search=test']) {
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  }
});

test('inactive referenced profiles retain admin history/deactivation but inactive trainers lose self-read', async () => {
  const token = await login(); const data = await create(token); const trainerToken = await login(trainer);
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { status: 'inactive' } });
  assert.equal((await send('get', `${path()}/${data.id}`, trainerToken)).status, 200);
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'suspended' } });
  error(await send('get', `${path()}/${data.id}`, trainerToken), 403, 'FORBIDDEN');
  assert.equal((await send('get', `${path()}/${data.id}`, token)).status, 200);
  assert.equal((await send('patch', `${path()}/${data.id}`, token, { status: 'inactive' })).status, 200);
});

test('inconsistent raw cross-gym references are never exposed by list/get/update', async () => {
  const token = await login();
  const invalid = await models.TrainerMemberAssignment.create(input({ gymId: gymA._id, memberId: memberB._id }));
  const result = await send('get', path(), token);
  assert.equal(result.body.data.length, 0); assert.equal(result.body.meta.pagination.total, 0);
  error(await send('get', `${path()}/${invalid._id}`, token), 404, 'MEMBER_NOT_FOUND');
  error(await send('patch', `${path()}/${invalid._id}`, token, { status: 'inactive' }), 404, 'MEMBER_NOT_FOUND');
});

test('bootstrap listener keeps assignments authenticated and no deletion or alternate route exists', async () => {
  const token = await login(); const data = await create(token);
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', '/api/v1/trainer-assignments', token)).status, 404);
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 1);
});

test('service methods recheck stale gym access and reject incomplete scope', async () => {
  const token = await login(); const data = await create(token); const { auth, authorization } = await context();
  const operations = [
    (scope) => service().create(auth, scope, input()), (scope) => service().get(auth, scope, data.id),
    (scope) => service().list(auth, scope, { page: 1, limit: 20 }),
    (scope) => service().update(auth, scope, data.id, { status: 'inactive' }),
  ];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
  assert.equal((await models.TrainerMemberAssignment.findById(data.id)).status, 'active');
});

test('database authorization/reference/read/write failures fail safely', async (t) => {
  const token = await login(); const data = await create(token);
  for (const [model, method, requestMethod, url, body] of [
    [models.GymAccess, 'findOne', 'post', path(), input()],
    [models.Gym, 'findOne', 'post', path(), input()],
    [models.TrainerProfile, 'findOne', 'post', path(), input()],
    [models.MemberProfile, 'findOne', 'post', path(), input()],
    [models.TrainerMemberAssignment, 'create', 'post', path(), input()],
    [models.TrainerMemberAssignment, 'aggregate', 'get', path()],
    [models.TrainerMemberAssignment, 'findOneAndUpdate', 'patch', `${path()}/${data.id}`, { status: 'inactive' }],
  ]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private database details'); });
    const response = await send(requestMethod, url, token, body);
    error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
    mock.mock.restore();
  }
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 1);
  assert.equal((await models.TrainerMemberAssignment.findById(data.id)).status, 'active');
});

test('trainer identity lookup errors fail closed without any read response', async (t) => {
  const token = await login(trainer);
  t.mock.method(models.TrainerProfile, 'find', () => { throw new Error('private identity lookup'); });
  const response = await send('get', path(), token);
  error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('authorization and trainer ownership denials never invoke assignment controllers', async () => {
  const express = require('express');
  const { createAssignmentRouter } = require('../../src/modules/trainerAssignments/assignment.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  const adminToken = await login(); const other = await create(adminToken, { trainerId: String(trainerOther._id) });
  let calls = 0;
  const forbidden = async () => { calls += 1; throw new Error('Controller reached'); };
  const protectedApp = express(); protectedApp.use(requestId); protectedApp.use(express.json());
  protectedApp.use('/api/v1/gyms/:gymId/trainer-assignments', createAssignmentRouter({ ...service(),
    create: forbidden, list: forbidden, get: forbidden, update: forbidden }, createAuthService({ ...models, config }),
  createAuthorizationMiddleware(createAuthorizationService(models))));
  protectedApp.use(errorHandler);
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [method, url, body] of [['post', path(), input()], ['patch', `${path()}/${other.id}`, { status: 'inactive' }],
      ['get', `${path()}/${other.id}`], ...(account === member ? [['get', path()]] : [])]) {
      const pending = request(protectedApp)[method](url).set('Authorization', `Bearer ${token}`);
      if (body) pending.send(body);
      error(await pending, account === trainer && method === 'get' ? 404 : 403,
        account === trainer && method === 'get' ? 'ASSIGNMENT_NOT_FOUND' : 'FORBIDDEN');
    }
  }
  assert.equal(calls, 0);
});

test('startup adds partial uniqueness indexes without dropping unrelated indexes', async () => {
  await models.TrainerMemberAssignment.collection.dropIndexes();
  await models.TrainerMemberAssignment.collection.createIndex({ assignedAt: 1 }, { name: 'retained_assignment_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.TrainerMemberAssignment.listIndexes();
    const unique = indexes.find((index) => index.name === 'assignment_active_relationship_unique');
    assert.equal(unique.unique, true); assert.deepEqual(unique.partialFilterExpression, { status: 'active' });
    assert.ok(indexes.some((index) => index.name === 'retained_assignment_index'));
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
  const address = { line1: '123 Test Road', city: 'Test City', countryCode: 'IN' };
  branchA = await models.Branch.create({ gymId: gymA._id, name: 'Branch A', nameKey: 'branch a', address });
  await models.Branch.create({ gymId: gymB._id, name: 'Branch B', nameKey: 'branch b', address });
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  trainerOther = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR02' });
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME02' });
  trainerB = await models.TrainerProfile.create({ ...person, gymId: gymB._id, trainerCode: 'TR01' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, memberCode: 'ME01' });
});
