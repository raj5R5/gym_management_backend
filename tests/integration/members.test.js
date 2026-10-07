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
const { createMemberService } = require('../../src/modules/members/member.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, branchA, branchB, admin, trainer, member, passwordHash;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/members`;
const input = (overrides = {}) => ({ memberCode: 'GYM001', firstName: 'Alex', lastName: 'River', phone: '+91 9876543210', ...overrides });
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
  return createMemberService({ ...models, authorizationService: createAuthorizationService(models) });
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
  const address = { line1: '123 Test Road', city: 'Test City', countryCode: 'IN' };
  branchA = await models.Branch.create({ gymId: gymA._id, name: 'Branch A', nameKey: 'branch a', address });
  branchB = await models.Branch.create({ gymId: gymB._id, name: 'Branch B', nameKey: 'branch b', address });
});

test('admin creates a standalone member with normalized code and no account/grant creation', async () => {
  const token = await login();
  const data = await create(token, { memberCode: ' gym001 ', branchId: String(branchA._id), dateOfBirth: '1995-06-12',
    gender: 'other', address: { line1: 'Home Road', city: 'City', countryCode: 'IN' },
    emergencyContact: { name: 'Pat', phone: '9876543211', relationship: 'Sibling' } });
  assert.equal(data.memberCode, 'GYM001'); assert.equal(data.status, 'active');
  assert.equal(data.gymId, String(gymA._id)); assert.equal(data.userId, undefined);
  assert.equal(data.dateOfBirth, '1995-06-12'); assert.ok(data.createdAt && data.updatedAt);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  for (const field of ['passwordHash', 'email', 'role', 'refreshToken']) assert.equal(field in data, false);
});

test('trainer and member cannot create or update, and unauthorized requests never reach the database operation', async (t) => {
  const token = await login(); const data = await create(token);
  let calls = 0;
  t.mock.method(models.MemberProfile, 'create', () => { calls += 1; throw new Error('Must not reach create'); });
  t.mock.method(models.MemberProfile, 'findOneAndUpdate', () => { calls += 1; throw new Error('Must not reach update'); });
  for (const account of [trainer, member]) {
    const denied = await login(account);
    error(await send('post', path(), denied, input()), 403, 'FORBIDDEN');
    error(await send('patch', `${path()}/${data.id}`, denied, { status: 'inactive' }), 403, 'FORBIDDEN');
  }
  assert.equal(calls, 0);
});

test('all member operations require authentication', async () => {
  for (const [method, url, body] of [['post', path(), input()], ['get', path()],
    ['get', `${path()}/${missingId()}`], ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('inactive/suspended/removed access and inactive/nonexistent gyms deny member operations', async () => {
  const token = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { status } });
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  error(await send('post', path({ _id: missingId() }), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.MemberProfile.countDocuments(), 0);
});

test('missing, invalid, inactive and cross-gym branch assignments are rejected', async () => {
  const token = await login();
  error(await send('post', path(), token, input({ branchId: 'invalid' })), 400, 'VALIDATION_ERROR');
  for (const branchId of [missingId(), String(branchB._id)]) {
    error(await send('post', path(), token, input({ branchId })), 404, 'BRANCH_NOT_FOUND');
  }
  await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'inactive' } });
  error(await send('post', path(), token, input({ branchId: String(branchA._id) })), 403, 'FORBIDDEN');
});

test('normalized code uniqueness is enforced by MongoDB under concurrent creation within one gym', async () => {
  const token = await login();
  const results = await Promise.all([' gym001 ', 'GYM001'].map((memberCode) => send('post', path(), token, input({ memberCode }))));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'DUPLICATE_MEMBER_CODE');
  assert.equal(await models.MemberProfile.countDocuments(), 1);
});

test('same code in different gyms is allowed and code conflicts do not enumerate other gyms', async () => {
  const token = await login(); await create(token);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const second = await create(token, {}, gymB);
  assert.equal(second.gymId, String(gymB._id)); assert.equal(await models.MemberProfile.countDocuments(), 2);
});

test('admin/trainer can list and get; members cannot read broad lists or individual profiles', async () => {
  const adminToken = await login(); const data = await create(adminToken);
  for (const account of [admin, trainer]) {
    const token = await login(account);
    const listed = await send('get', path(), token);
    assert.equal(listed.status, 200); assert.equal(listed.body.data.length, 1);
    assert.equal((await send('get', `${path()}/${data.id}`, token)).status, 200);
  }
  const token = await login(member);
  error(await send('get', path(), token), 403, 'FORBIDDEN');
  error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
});

test('pagination is bounded and stable and metadata totals respect status and search', async () => {
  const token = await login();
  for (const [memberCode, status] of [['A01', 'active'], ['A02', 'inactive'], ['A03', 'active']]) await create(token, { memberCode, status });
  const first = await send('get', `${path()}?page=1&limit=2`, token);
  const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 });
  assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filtered = await send('get', `${path()}?status=inactive&search=a02`, token);
  assert.equal(filtered.body.data[0].memberCode, 'A02'); assert.equal(filtered.body.meta.pagination.total, 1);
});

test('literal search covers code, names and phone and never acts as regex or query passthrough', async () => {
  const token = await login(); await create(token, { firstName: 'Zoë', lastName: 'River' });
  for (const search of ['gym001', 'zoë', 'river', '987654']) {
    const result = await send('get', `${path()}?search=${encodeURIComponent(search)}`, token);
    assert.equal(result.body.data.length, 1);
  }
  assert.equal((await send('get', `${path()}?search=${encodeURIComponent('.*')}`, token)).body.data.length, 0);
  for (const suffix of ['search[$ne]=x', 'status[$ne]=x', 'gymId=x', 'role=admin', 'search=x&search=y',
    'page=0', 'page=1.5', 'limit=101', 'status=unknown', 'search=', `search=${'x'.repeat(101)}`]) {
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  }
});

test('member ID lookup/update always includes gym scope even when actor has access to both gyms', async () => {
  const token = await login(); await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, {}, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'MEMBER_NOT_FOUND');
  error(await send('patch', `${path()}/${foreign.id}`, token, { firstName: 'Changed' }), 404, 'MEMBER_NOT_FOUND');
  assert.equal((await models.MemberProfile.findById(foreign.id)).firstName, 'Alex');
  assert.equal((await send('get', path(), token)).body.data.length, 0);
});

test('client cannot override user, role, scope or access status and no account is silently linked', async () => {
  const token = await login();
  for (const extra of [{ userId: String(member._id) }, { userId: missingId() }, { role: 'admin' },
    { gymId: String(gymB._id) }, { accessStatus: 'active' }, { password: 'not accepted' }, { email: 'x@example.com' },
    { trainerId: missingId() }, { permissions: ['all'] }, { $set: { gymId: String(gymB._id) } }]) {
    error(await send('post', path(), token, input(extra)), 400, 'VALIDATION_ERROR');
  }
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  assert.equal(await models.MemberProfile.countDocuments(), 0);
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
    assert.equal(response.body.data.memberCode, data.memberCode); assert.equal(response.body.data.lastName, 'River');
  }
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  assert.equal((await models.UserAccount.findById(admin._id)).status, 'active');
});

test('gym, user and member code are immutable through PATCH and model query updates', async () => {
  const token = await login(); const data = await create(token);
  for (const patch of [{ gymId: String(gymB._id) }, { userId: String(member._id) }, { memberCode: 'GYM002' },
    { createdAt: new Date().toISOString() }, { _id: missingId() }, { role: 'member' }, {}]) {
    error(await send('patch', `${path()}/${data.id}`, token, patch), 400, 'VALIDATION_ERROR');
  }
  // Mongoose strips immutable changes rather than rejecting this query.
  await models.MemberProfile.findOneAndUpdate({ _id: data.id },
    { $set: { gymId: gymB._id, userId: member._id, memberCode: 'CHANGED' } }, { runValidators: true });
  const preserved = await models.MemberProfile.findById(data.id);
  assert.equal(preserved.memberCode, data.memberCode); assert.equal(preserved.userId, undefined);
  assert.equal((await models.MemberProfile.findById(data.id)).gymId.toString(), String(gymA._id));
});

test('branch updates allow same-gym movement/removal but reject foreign/inactive/missing branches', async () => {
  const token = await login(); const data = await create(token);
  const updated = await send('patch', `${path()}/${data.id}`, token, { branchId: String(branchA._id) });
  assert.equal(updated.status, 200); assert.equal(updated.body.data.branchId, String(branchA._id));
  for (const branchId of [String(branchB._id), missingId()]) {
    error(await send('patch', `${path()}/${data.id}`, token, { branchId }), 404, 'BRANCH_NOT_FOUND');
  }
  await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'inactive' } });
  error(await send('patch', `${path()}/${data.id}`, token, { branchId: String(branchA._id) }), 403, 'FORBIDDEN');
  assert.equal((await send('patch', `${path()}/${data.id}`, token, { branchId: null })).body.data.branchId, undefined);
});

test('strict input validation rejects bad required fields, dates, contact data and unsupported future fields', async () => {
  const token = await login();
  for (const patch of [{ firstName: '' }, { lastName: ' ' }, { phone: 'abc' }, { phone: '1234' },
    { phone: '+1234567890123456' }, { memberCode: 'A' }, { memberCode: 'A B' }, { memberCode: 'X'.repeat(33) },
    { status: 'deleted' }, { gender: 'invalid' }, { dateOfBirth: '2024-02-30' }, { dateOfBirth: '2999-01-01' },
    { dateOfBirth: '2020-01-01T00:00:00Z' }, { dateOfBirth: 'bad' }, { emergencyContact: { name: 'Pat', phone: 'bad' } },
    { address: { line1: 'Road', city: 'City', countryCode: 'India' } }, { address: { line1: 'Road', city: 'City', countryCode: 'IN', role: 'admin' } }]) {
    error(await send('post', path(), token, input(patch)), 400, 'VALIDATION_ERROR');
  }
  const data = await create(token);
  error(await send('patch', `${path()}/${data.id}`, token, { status: 'unknown' }), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('post', path({ _id: 'invalid' }), token, input()), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'MEMBER_NOT_FOUND');
});

test('optional fields can be cleared without removing required data', async () => {
  const token = await login(); const data = await create(token, { dateOfBirth: '2000-01-01', gender: 'other',
    emergencyContact: { name: 'Pat', phone: '9876543211' }, address: { line1: 'Road', city: 'City', countryCode: 'IN' } });
  const response = await send('patch', `${path()}/${data.id}`, token,
    { dateOfBirth: null, gender: null, emergencyContact: null, address: null });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.dateOfBirth, undefined); assert.equal(response.body.data.address, undefined);
  error(await send('patch', `${path()}/${data.id}`, token, { firstName: null }), 400, 'VALIDATION_ERROR');
});

test('member routes remain protected on the bootstrap listener and no deletion route exists', async () => {
  const token = await login(); const data = await create(token);
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}`, token)).status, 404);
  assert.equal(await models.MemberProfile.countDocuments(), 1);
});

test('database errors fail safely without exposing details or performing protected writes', async (t) => {
  const token = await login();
  t.mock.method(models.MemberProfile, 'create', async () => { throw new Error('private database credentials'); });
  const response = await send('post', path(), token, input());
  error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('service rechecks current gym access instead of trusting stale authorization context', async () => {
  await login(); const { auth, authorization } = await context();
  await models.GymAccess.updateOne({ userId: admin._id, gymId: gymA._id }, { $set: { role: 'trainer' } });
  await assert.rejects(service().create(auth, authorization, input()), { code: 'FORBIDDEN' });
  assert.equal(await models.MemberProfile.countDocuments(), 0);
});

test('startup creates member uniqueness indexes without dropping unrelated indexes', async () => {
  await models.MemberProfile.collection.dropIndexes();
  await models.MemberProfile.collection.createIndex({ firstName: 1 }, { name: 'retained_member_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.MemberProfile.listIndexes();
    assert.ok(indexes.some((index) => index.name === 'member_gym_code_unique' && index.unique));
    assert.ok(indexes.some((index) => index.name === 'retained_member_index'));
  } finally { await lifecycle.shutdown('test'); }
});

test('role denials never invoke member controllers, independently of service defenses', async () => {
  const express = require('express');
  const { createMemberRouter } = require('../../src/modules/members/member.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  let calls = 0;
  const forbiddenCall = async () => { calls += 1; throw new Error('Controller was reached'); };
  const protectedApp = express();
  protectedApp.use(requestId); protectedApp.use(express.json());
  protectedApp.use('/api/v1/gyms/:gymId/members', createMemberRouter({ create: forbiddenCall, list: forbiddenCall,
    get: forbiddenCall, update: forbiddenCall }, createAuthService({ ...models, config }),
  createAuthorizationMiddleware(createAuthorizationService(models))));
  protectedApp.use(errorHandler);
  const token = await login(member);
  for (const [method, url, body] of [['post', path(), input()], ['get', path()], ['get', `${path()}/${missingId()}`],
    ['patch', `${path()}/${missingId()}`, { status: 'inactive' }]]) {
    const pending = request(protectedApp)[method](url).set('Authorization', `Bearer ${token}`);
    if (body) pending.send(body);
    error(await pending, 403, 'FORBIDDEN');
  }
  assert.equal(calls, 0);
});
