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
const { createAssignmentService } = require('../../src/modules/trainerAssignments/assignment.service');
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

const trainerView = (profile = trainerA, gym = gymA) => `/api/v1/gyms/${gym._id}/trainers/${profile._id}/members`;
const memberView = (profile = memberA, gym = gymA) => `/api/v1/gyms/${gym._id}/members/${profile._id}/trainers`;
const deactivate = (assignment, gym = gymA) => `${path(gym)}/${assignment.id}/deactivate`;
test('established assignment contracts retain assignedAt, inactive detail/history and empty hostile filters', async () => {
  const adminToken = await login(); const assignment = await create(adminToken, { assignedAt: '2024-01-01T12:30:00+05:30' });
  assert.equal(assignment.assignedAt, '2024-01-01T07:00:00.000Z');
  assert.equal(assignment.endedAt, undefined);
  const token = await login(trainer);
  const hostile = await send('get', `${path()}?trainerId=${trainerOther._id}`, token);
  assert.equal(hostile.status, 200); assert.deepEqual(hostile.body.data, []);
  assert.deepEqual(hostile.body.meta.pagination, { page: 1, limit: 20, total: 0 });
  const deactivated = await send('patch', `${path()}/${assignment.id}`, adminToken, { status: 'inactive' });
  assert.equal(deactivated.status, 200);
  const detail = await send('get', `${path()}/${assignment.id}`, token);
  assert.equal(detail.status, 200); assert.deepEqual(detail.body.data, deactivated.body.data);
  const history = await send('get', `${path()}?status=inactive`, token);
  assert.equal(history.status, 200); assert.deepEqual(history.body.data, [deactivated.body.data]);
  assert.deepEqual((await send('get', path(), token)).body.data, [deactivated.body.data]);
  error(await send('get', trainerView(trainerOther), token), 403, 'FORBIDDEN');
  error(await send('get', memberView(), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('get', trainerView()+'?status=inactive', token), 403, 'FORBIDDEN');
});
test('admin operational views may inspect any own-gym trainer and member including history', async () => {
  const token = await login(); const assignment = await create(token, { trainerId: String(trainerOther._id), memberId: String(memberOther._id) });
  for (const url of [trainerView(trainerOther), memberView(memberOther)]) {
    const response = await send('get', url, token); assert.equal(response.status, 200);
    assert.equal(response.body.data[0].assignmentId, assignment.id);
    assert.deepEqual(response.body.meta.pagination, { page: 1, limit: 20, total: 1 });
  }
  assert.equal((await send('patch', deactivate(assignment), token, {})).status, 200);
  for (const url of [trainerView(trainerOther), memberView(memberOther)]) {
    const active = await send('get', url, token); assert.equal(active.status, 200); assert.deepEqual(active.body.data, []);
    const history = await send('get', url+'?status=inactive', token); assert.equal(history.status, 200);
    assert.equal(history.body.data[0].assignmentId, assignment.id); assert.equal(history.body.data[0].assignmentStatus, 'inactive');
  }
});
test('inactive and suspended trainer GymAccess deny both operational views', async () => {
  await create(await login()); const token = await login(trainer);
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: trainer._id, gymId: gymA._id }, { status });
    for (const url of [trainerView(), memberView()]) error(await send('get', url, token), 403, 'FORBIDDEN');
  }
});
test('admin scoped views return safe counterpart profiles and no unrelated private fields', async () => {
  const token = await login(); const assignment = await create(token);
  for (const [url, key, code, id] of [[trainerView(), 'memberId', 'memberCode', memberA._id], [memberView(), 'trainerId', 'trainerCode', trainerA._id]]) {
    const response = await send('get', url, token); assert.equal(response.status, 200);
    assert.deepEqual(response.body.meta.pagination, { page: 1, limit: 20, total: 1 });
    const row = response.body.data[0]; assert.equal(row[key], String(id)); assert.equal(row.assignmentId, assignment.id);
    assert.equal(row.assignmentStatus, 'active'); assert.equal(row.phone, '9876543210');
    assert.deepEqual(Object.keys(row).sort(), [key, code, 'firstName', 'lastName', 'phone', 'status', 'assignmentId', 'assignedAt', 'assignmentStatus'].sort());
    assert.doesNotMatch(JSON.stringify(response.body), /password|token|session|userId|address|dateOfBirth|emergencyContact|__v|"_id"/i);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});
test('trainer views never expose another trainer relationship, even for a shared member', async () => {
  const adminToken = await login(); const own = await create(adminToken);
  await create(adminToken, { trainerId: String(trainerOther._id) });
  await create(adminToken, { trainerId: String(trainerOther._id), memberId: String(memberOther._id) });
  const token = await login(trainer);
  for (const url of [trainerView(), memberView()]) {
    const response = await send('get', url, token); assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.map((row) => row.assignmentId), [own.id]);
  }
  error(await send('get', trainerView(trainerOther), token), 403, 'FORBIDDEN');
  error(await send('get', memberView(memberOther), token), 404, 'MEMBER_NOT_FOUND');
  for (const url of [trainerView()+'?status=inactive', memberView()+'?status=inactive']) error(await send('get', url, token), 403, 'FORBIDDEN');
});
test('assignment deactivation removes trainer member-view access immediately', async () => {
  const adminToken = await login(); const assignment = await create(adminToken); const token = await login(trainer);
  assert.equal((await send('get', memberView(), token)).status, 200);
  assert.equal((await send('patch', deactivate(assignment), adminToken, {})).status, 200);
  error(await send('get', memberView(), token), 404, 'MEMBER_NOT_FOUND');
  const response = await send('get', trainerView(), token); assert.equal(response.status, 200); assert.deepEqual(response.body.data, []);
});
test('new deactivation endpoint preserves periods and endedAt under retries and concurrency', async () => {
  const token = await login(); const assignment = await create(token);
  const responses = await Promise.all([send('patch', deactivate(assignment), token, {}), send('patch', deactivate(assignment), token, {})]);
  for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.body.data.status, 'inactive'); }
  assert.equal(responses[0].body.data.endedAt, responses[1].body.data.endedAt);
  const row = responses[0].body.data;
  assert.ok(Date.parse(row.endedAt) >= Date.parse(row.assignedAt));
  assert.equal(row.assignedAt, assignment.assignedAt); assert.equal(row.trainerId, assignment.trainerId); assert.equal(row.memberId, assignment.memberId);
  assert.deepEqual((await send('patch', deactivate(assignment), token)).body.data, row);
  const next = await create(token); assert.notEqual(next.id, assignment.id);
  assert.equal((await send('get', memberView()+'?status=inactive', token)).body.data[0].assignmentId, assignment.id);
  assert.equal((await send('get', trainerView(), token)).body.data[0].assignmentId, next.id);
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 2);
});
test('concurrent creation still relies on the existing unique active relationship constraint', async () => {
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input()), send('post', path(), token, input())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  error(responses.find((response) => response.status === 409), 409, 'DUPLICATE_ACTIVE_ASSIGNMENT');
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 1);
});
test('members and anonymous clients cannot use scoped views or deactivate', async () => {
  const assignment = await create(await login()); const token = await login(member);
  for (const [method, url, body] of [['get', trainerView()], ['get', memberView()], ['patch', deactivate(assignment), {}]]) {
    error(await send(method, url, token, body), 403, 'FORBIDDEN');
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
  error(await send('patch', deactivate(assignment), await login(trainer), {}), 403, 'FORBIDDEN');
});
for (const status of ['inactive', 'suspended']) test(`${status} GymAccess denies all new operations`, async () => {
  const token = await login(); const assignment = await create(token); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  for (const [method, url, body] of [['get', trainerView()], ['get', memberView()], ['patch', deactivate(assignment), {}]]) error(await send(method, url, token, body), 403, 'FORBIDDEN');
});
test('inactive gym and cross-gym resources cannot be read or changed', async () => {
  const token = await login(); const assignment = await create(token);
  error(await send('get', trainerView(trainerB, gymB), token), 403, 'FORBIDDEN');
  error(await send('get', memberView(memberB, gymB), token), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { trainerId: String(trainerB._id), memberId: String(memberB._id) }, gymB);
  error(await send('get', trainerView(trainerB), token), 404, 'TRAINER_NOT_FOUND');
  error(await send('get', memberView(memberB), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('patch', deactivate(foreign), token, {}), 404, 'ASSIGNMENT_NOT_FOUND');
  assert.equal((await models.TrainerMemberAssignment.findById(foreign.id)).status, 'active');
  const trainerToken = await login(trainer);
  error(await send('get', trainerView(trainerB, gymB), trainerToken), 403, 'FORBIDDEN');
  error(await send('get', memberView(memberB), trainerToken), 404, 'MEMBER_NOT_FOUND');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  for (const [method, url, body] of [['get', trainerView()], ['get', memberView()], ['patch', deactivate(assignment), {}]]) error(await send(method, url, token, body), 403, 'FORBIDDEN');
});
for (const condition of ['missing', 'inactive', 'suspended', 'ambiguous']) test(`${condition} authenticated trainer profile fails closed on scoped views`, async () => {
  await create(await login()); const token = await login(trainer);
  if (condition === 'missing') await models.TrainerProfile.deleteOne({ _id: trainerA._id });
  else if (condition === 'ambiguous') await models.TrainerProfile.collection.updateOne({ _id: trainerOther._id }, { $set: { userId: trainer._id } });
  else await models.TrainerProfile.updateOne({ _id: trainerA._id }, { status: condition });
  for (const url of [trainerView(), memberView()]) error(await send('get', url, token), 403, 'FORBIDDEN');
});
test('profile status changes never mutate assignment history', async () => {
  const token = await login(); const assignment = await create(token); const before = await models.TrainerMemberAssignment.findById(assignment.id).lean();
  await models.MemberProfile.updateOne({ _id: memberA._id }, { status: 'suspended' });
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { status: 'inactive' });
  assert.equal((await send('get', trainerView(), token)).body.data[0].status, 'suspended');
  assert.equal((await send('get', memberView(), token)).body.data[0].status, 'inactive');
  assert.deepEqual(await models.TrainerMemberAssignment.findById(assignment.id).lean(), before);
  error(await send('post', path(), token, input({ memberId: String(memberOther._id) })), 403, 'FORBIDDEN');
});
test('branch differences and subsequent transfers preserve relationship history', async () => {
  const otherBranch = await models.Branch.create({ gymId: gymA._id, name: 'Other', nameKey: 'other', address: { line1: 'Road', city: 'City', countryCode: 'IN' } });
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { branchId: branchA._id });
  await models.MemberProfile.updateOne({ _id: memberA._id }, { branchId: otherBranch._id });
  const token = await login(); const assignment = await create(token); const before = await models.TrainerMemberAssignment.findById(assignment.id).lean();
  assert.equal((await send('get', trainerView(), token)).body.data[0].branchId, String(otherBranch._id));
  assert.equal((await send('get', memberView(), token)).body.data[0].branchId, String(branchA._id));
  await models.MemberProfile.updateOne({ _id: memberA._id }, { branchId: branchA._id });
  assert.equal((await send('get', trainerView(), token)).body.data[0].branchId, String(branchA._id));
  assert.deepEqual(await models.TrainerMemberAssignment.findById(assignment.id).lean(), before);
  const foreignBranch = await models.Branch.findOne({ gymId: gymB._id });
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { branchId: foreignBranch._id } });
  assert.equal((await send('get', trainerView(), token)).body.data[0].branchId, undefined);
});
test('scoped pagination sorts deterministically and counts only eligible joined rows', async () => {
  const token = await login(); const first = await create(token); const second = await create(token, { memberId: String(memberOther._id) });
  const fixed = new Date('2025-01-01T00:00:00Z'); await models.TrainerMemberAssignment.updateMany({}, { createdAt: fixed });
  const expected = [first.id, second.id].sort().reverse();
  const one = await send('get', trainerView()+'?page=1&limit=1', token); const two = await send('get', trainerView()+'?page=2&limit=1', token);
  assert.deepEqual([...one.body.data, ...two.body.data].map((row) => row.assignmentId), expected);
  assert.deepEqual(one.body.meta.pagination, { page: 1, limit: 1, total: 2 });
  assert.equal((await send('get', trainerView()+'?page=10000&limit=100', token)).body.data.length, 0);
  await send('patch', deactivate(first), token, {});
  assert.equal((await send('get', trainerView(), token)).body.meta.pagination.total, 1);
  assert.equal((await send('get', trainerView()+'?status=inactive', token)).body.data[0].assignmentId, first.id);
});
test('strict IDs, query fields, operators and deactivate bodies cannot override scope', async () => {
  const token = await login(); const assignment = await create(token);
  for (const url of [trainerView(), memberView()]) for (const suffix of ['status=paused', 'status[$ne]=active', 'page=0', 'page=10001', 'page=1.5', 'limit=101', 'limit=0',
    'trainerId='+trainerOther._id, 'memberId='+memberOther._id, 'gymId='+gymB._id, 'userId='+admin._id, 'role=admin', 'status=active&status=inactive'])
    error(await send('get', url+'?'+suffix, token), 400, 'VALIDATION_ERROR');
  for (const url of [trainerView({ _id: 'bad' }), memberView({ _id: 'bad' }), `${path()}/bad/deactivate`]) error(await send(url.endsWith('deactivate') ? 'patch' : 'get', url, token, url.endsWith('deactivate') ? {} : undefined), 400, 'VALIDATION_ERROR');
  for (const body of [{ status: 'active' }, { endedAt: new Date().toISOString() }, { trainerId: String(trainerOther._id) }, { $set: { status: 'active' } }])
    error(await send('patch', deactivate(assignment), token, body), 400, 'VALIDATION_ERROR');
  error(await send('patch', deactivate(assignment)+'?trainerId='+trainerOther._id, token, {}), 400, 'VALIDATION_ERROR');
  error(await send('get', trainerView({ _id: missingId() }), token), 404, 'TRAINER_NOT_FOUND');
  error(await send('get', memberView({ _id: missingId() }), token), 404, 'MEMBER_NOT_FOUND');
});
test('corrupt missing and cross-gym references are excluded before counts or DTOs', async () => {
  const token = await login();
  for (const trainerId of [trainerB._id, missingId()]) await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId, memberId: memberA._id });
  for (const memberId of [memberB._id, missingId()]) await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId });
  for (const url of [trainerView(), memberView()]) { const response = await send('get', url, token); assert.equal(response.status, 200); assert.deepEqual(response.body.data, []); assert.equal(response.body.meta.pagination.total, 0); }
});
test('database failures fail safely without partial profile data or deactivation', async (t) => {
  const token = await login(); const assignment = await create(token);
  for (const [model, method, url, verb] of [[models.TrainerProfile, 'exists', trainerView(), 'get'], [models.MemberProfile, 'exists', memberView(), 'get'],
    [models.TrainerMemberAssignment, 'aggregate', trainerView(), 'get'], [models.TrainerMemberAssignment, 'findOneAndUpdate', deactivate(assignment), 'patch']]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private database credentials'); });
    const response = await send(verb, url, token, verb === 'patch' ? {} : undefined); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /private database credentials/); mock.mock.restore();
  }
  assert.equal((await models.TrainerMemberAssignment.findById(assignment.id)).status, 'active');
});
test('scoped reads perform one joined aggregation with no per-row profile lookups or writes', async (t) => {
  const token = await login(); await create(token); await create(token, { memberId: String(memberOther._id) });
  let calls = 0; const original = models.TrainerMemberAssignment.aggregate;
  t.mock.method(models.TrainerMemberAssignment, 'aggregate', function (...args) { calls++; return original.apply(this, args); });
  let profileReads = 0;
  for (const model of [models.TrainerProfile, models.MemberProfile]) {
    const findOne = model.findOne;
    t.mock.method(model, 'findOne', function (...args) { profileReads++; return findOne.apply(this, args); });
  }
  for (const model of Object.values(models)) for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany']) t.mock.method(model, method, () => { throw new Error('Read attempted write'); });
  assert.equal((await send('get', trainerView(), token)).status, 200); assert.equal(calls, 1); assert.equal(profileReads, 1);
});
test('services reject missing/stale scope and bootstrap cannot bypass authentication', async () => {
  const token = await login(); const assignment = await create(token); const { auth, authorization } = await context();
  const operations = [(scope) => service().trainerMembers(auth, scope, String(trainerA._id), { page: 1, limit: 20 }),
    (scope) => service().memberTrainers(auth, scope, String(memberA._id), { page: 1, limit: 20 })];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { status: 'inactive' });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  for (const url of [trainerView(), memberView()]) error(await request(bootstrap).get(url), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).patch(deactivate(assignment)).send({}), 401, 'INVALID_AUTHENTICATION');
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
