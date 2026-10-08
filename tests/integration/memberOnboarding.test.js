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

const onboarding = (gym = gymA) => `/api/v1/gyms/${gym._id}/member-onboarding`;
async function onboard(token, overrides = {}, gym = gymA) {
  const response = await send('post', onboarding(gym), token, input(overrides));
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
for (const role of ['admin', 'trainer']) test(`${role} onboards a standalone active member without assignments`, async () => {
  const data = await onboard(await login(role === 'admin' ? admin : trainer));
  assert.equal(data.status, 'active'); assert.equal(data.gymId, String(gymA._id)); assert.equal(data.memberCode, 'GYM001');
  assert.equal(data.branchId, undefined); assert.equal(data.userId, undefined);
  assert.equal(await models.MemberProfile.countDocuments(), 1); assert.equal(await models.TrainerProfile.countDocuments(), 0);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  for (const name of ['MemberSubscription', 'Payment', 'TrainerMemberAssignment', 'Attendance']) assert.equal(await models[name].countDocuments(), 0);
});
test('member and anonymous requests denied before any insert', async (t) => {
  const token = await login(member); let calls = 0;
  t.mock.method(models.MemberProfile, 'create', () => { calls++; throw new Error('Unexpected insert'); });
  error(await send('post', onboarding(), token, input()), 403, 'FORBIDDEN');
  error(await send('post', onboarding(), undefined, input()), 401, 'INVALID_AUTHENTICATION'); assert.equal(calls, 0);
});
for (const status of ['inactive', 'suspended']) test(`${status} GymAccess denies onboarding`, async () => {
  const token = await login(trainer); await models.GymAccess.updateOne({ userId: trainer._id }, { status });
  error(await send('post', onboarding(), token, input()), 403, 'FORBIDDEN'); assert.equal(await models.MemberProfile.countDocuments(), 0);
});
test('inactive gym denies onboarding', async () => {
  const token = await login(); await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  error(await send('post', onboarding(), token, input()), 403, 'FORBIDDEN');
});
test('admin and trainer cannot select an unauthorized gym', async () => {
  for (const user of [admin, trainer]) error(await send('post', onboarding(gymB), await login(user), input()), 403, 'FORBIDDEN');
  assert.equal(await models.MemberProfile.countDocuments(), 0);
});
test('required fields, lengths and formats reuse existing member validation', async () => {
  const token = await login();
  for (const field of ['memberCode', 'firstName', 'lastName', 'phone']) {
    const body = input(); delete body[field]; error(await send('post', onboarding(), token, body), 400, 'VALIDATION_ERROR');
  }
  for (const changes of [{ memberCode: 'x' }, { memberCode: 'invalid space' }, { memberCode: 'x'.repeat(33) }, { firstName: ' ' },
    { firstName: 'x'.repeat(81) }, { lastName: 'x'.repeat(81) }, { phone: 'abc' }, { phone: '123' }, { phone: '1'.repeat(16) },
    { phone: { $ne: null } }, { branchId: null }, { branchId: 'bad' }, { dateOfBirth: '2026-02-30' }, { dateOfBirth: '9999-01-01' },
    { gender: 'unknown' }, { address: { line1: 'Home', city: 'City', countryCode: 'in' } }, { emergencyContact: { name: 'Pat', phone: 'bad' } }])
    error(await send('post', onboarding(), token, input(changes)), 400, 'VALIDATION_ERROR');
  assert.equal(await models.MemberProfile.countDocuments(), 0);
});
test('optional fields and active branch return existing safe member DTO', async () => {
  const token = await login(); const response = await send('post', onboarding(), token, input({ memberCode: ' gym001 ', branchId: String(branchA._id),
    dateOfBirth: '1995-06-12', gender: 'prefer_not_to_say', address: { line1: 'Home Road', line2: 'Suite 1', city: 'City', state: 'State', postalCode: '411001', countryCode: 'IN' },
    emergencyContact: { name: 'Pat', phone: '9876543211', relationship: 'Sibling' } }));
  assert.equal(response.status, 201); const data = response.body.data;
  assert.deepEqual(Object.keys(data).sort(), ['id', 'gymId', 'branchId', 'memberCode', 'firstName', 'lastName', 'phone', 'dateOfBirth', 'gender', 'address', 'emergencyContact', 'status', 'createdAt', 'updatedAt'].sort());
  assert.equal(data.memberCode, 'GYM001'); assert.equal(data.branchId, String(branchA._id)); assert.equal(data.dateOfBirth, '1995-06-12');
  assert.equal(data.gender, 'prefer_not_to_say'); assert.equal(data.emergencyContact.name, 'Pat'); assert.equal(data.address.countryCode, 'IN');
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']); assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(data), /password|token|session|normalized|__v|"_id"|userId|role|permissions/i);
});
test('missing and foreign branches rejected; inactive branch rejected', async () => {
  const token = await login();
  for (const branchId of [missingId(), String(branchB._id)]) error(await send('post', onboarding(), token, input({ branchId })), 404, 'BRANCH_NOT_FOUND');
  await models.Branch.updateOne({ _id: branchA._id }, { status: 'inactive' });
  error(await send('post', onboarding(), token, input({ branchId: String(branchA._id) })), 403, 'FORBIDDEN');
  assert.equal(await models.MemberProfile.countDocuments(), 0);
});
test('duplicate normalized member code conflicts without changing original member', async () => {
  const token = await login(); const data = await onboard(token); const before = await models.MemberProfile.findById(data.id).lean();
  error(await send('post', onboarding(), token, input({ memberCode: ' gym001 ', firstName: 'Changed' })), 409, 'DUPLICATE_MEMBER_CODE');
  assert.deepEqual(await models.MemberProfile.findById(data.id).lean(), before); assert.equal(await models.MemberProfile.countDocuments(), 1);
});
test('concurrent duplicate onboarding is protected by existing database uniqueness', async () => {
  const token = await login(); const results = await Promise.all([send('post', onboarding(), token, input()), send('post', onboarding(), token, input({ memberCode: ' gym001 ' }))]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal(results.find((response) => response.status === 409).body.error.code, 'DUPLICATE_MEMBER_CODE');
  assert.equal(await models.MemberProfile.countDocuments(), 1);
});
test('same code in distinct authorized gyms and shared phone numbers are supported', async () => {
  const token = await login(); await onboard(token); await onboard(token, { memberCode: 'GYM002' });
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' }); await onboard(token, {}, gymB);
  assert.equal(await models.MemberProfile.countDocuments({ phone: input().phone }), 3);
});
for (const field of ['gymId', 'userId', 'status', 'createdAt', 'updatedAt', 'normalizedEmail', 'normalizedMemberCode', '_id', 'id', 'password', 'passwordHash',
  'refreshToken', 'sessionId', 'subscriptionId', 'planId', 'membershipPlanId', 'payment', 'amountPaise', 'trainerId', 'assignmentId', 'role', 'permissions', 'unknown'])
  test(`onboarding rejects protected field ${field}`, async () => {
    error(await send('post', onboarding(), await login(), input({ [field]: 'untrusted' })), 400, 'VALIDATION_ERROR');
    assert.equal(await models.MemberProfile.countDocuments(), 0);
  });
test('nested unknown fields, operators and invalid gym IDs are rejected', async () => {
  const token = await login();
  for (const changes of [{ $where: 'true' }, { memberCode: { $ne: null } }, { branchId: { $ne: null } },
    { address: { line1: 'Home', city: 'City', countryCode: 'IN', passwordHash: 'untrusted' } },
    { emergencyContact: { name: 'Pat', phone: '9876543211', userId: missingId() } }])
    error(await send('post', onboarding(), token, input(changes)), 400, 'VALIDATION_ERROR');
  error(await send('post', onboarding({ _id: 'bad' }), token, input()), 400, 'VALIDATION_ERROR');
});
test('existing member creation/read/update behavior and cross-gym isolation remain intact', async () => {
  const token = await login(); const old = await create(token, { status: 'inactive' });
  assert.equal(old.status, 'inactive');
  const created = await onboard(token, { memberCode: 'GYM002' });
  assert.equal((await send('get', `${path()}/${created.id}`, token)).status, 200);
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 2);
  assert.equal((await send('patch', `${path()}/${created.id}`, token, { status: 'suspended', phone: '9876543211' })).body.data.status, 'suspended');
  const trainerToken = await login(trainer); error(await send('post', path(), trainerToken, input({ memberCode: 'GYM003' })), 403, 'FORBIDDEN');
  error(await send('patch', `${path()}/${created.id}`, trainerToken, { status: 'active' }), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  error(await send('get', `${path(gymB)}/${created.id}`, token), 404, 'MEMBER_NOT_FOUND');
  error(await send('patch', `${path(gymB)}/${created.id}`, token, { firstName: 'Changed' }), 404, 'MEMBER_NOT_FOUND');
  const raw = await models.MemberProfile.findById(created.id); assert.equal(raw.memberCode, 'GYM002');
});
test('authorization, branch and insert failures fail safely without partial members', async (t) => {
  const token = await login();
  for (const [model, method] of [[models.GymAccess, 'findOne'], [models.Gym, 'findOne'], [models.Branch, 'findOne'], [models.MemberProfile, 'create']]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private credentials'); });
    const response = await send('post', onboarding(), token, input({ branchId: String(branchA._id) })); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /private credentials/); mock.mock.restore(); assert.equal(await models.MemberProfile.countDocuments(), 0);
  }
});
test('service independently rejects incomplete and stale gym authorization', async () => {
  await login(); const { auth, authorization } = await context();
  for (const selected of [undefined, { ...authorization, gymId: undefined }, { ...authorization, role: 'member' }])
    await assert.rejects(service().onboard(auth, selected, input()), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { status: 'inactive' });
  await assert.rejects(service().onboard(auth, authorization, input()), { code: 'FORBIDDEN' });
});
test('standalone onboarding uses one insert, no transaction or side-effect domain writes', async (t) => {
  const token = await login(); const snapshot = async () => JSON.stringify(await Promise.all(Object.entries(models).filter(([name]) => name !== 'MemberProfile').map(([, model]) => model.find().sort('_id').lean())));
  const before = await snapshot(); const original = models.MemberProfile.create; let inserts = 0;
  t.mock.method(models.MemberProfile, 'create', function (...args) { inserts++; return original.apply(this, args); });
  t.mock.method(database.connection, 'startSession', () => { throw new Error('Onboarding must not require a transaction'); });
  for (const [name, model] of Object.entries(models)) if (name !== 'MemberProfile') for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'insertMany'])
    t.mock.method(model, method, () => { throw new Error('Unexpected side effect'); });
  await onboard(token); assert.equal(inserts, 1); assert.equal(await snapshot(), before);
});
test('bootstrap listener cannot bypass authentication for onboarding', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(onboarding()).send(input()), 401, 'INVALID_AUTHENTICATION');
});
