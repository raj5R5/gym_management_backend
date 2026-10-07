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
const { createAttendanceService } = require('../../src/modules/attendance/attendance.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, branchA, branchOther, branchB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/attendance`;
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
  const response = await send('post', subscriptionPath(gym), token, input(overrides));
  assert.equal(response.status, 201);
  return response.body.data;
}
function service() {
  return createAttendanceService({ ...models, authorizationService: createAuthorizationService(models) });
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
  const address = { line1: '1 Main Road', city: 'Pune', countryCode: 'IN' };
  branchA = await models.Branch.create({ gymId: gymA._id, name: 'Main', nameKey: 'main', address });
  branchOther = await models.Branch.create({ gymId: gymA._id, name: 'Other', nameKey: 'other', address });
  branchB = await models.Branch.create({ gymId: gymB._id, name: 'Main', nameKey: 'main', address });
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME02' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, branchId: branchB._id, memberCode: 'ME01' });
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  assignment = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});

const checkInInput = (overrides = {}) => ({ memberId: String(memberA._id), branchId: String(branchA._id), ...overrides });
async function visit(token, overrides = {}, gym = gymA) {
  const response = await send('post', `${path(gym)}/check-in`, token, checkInInput(overrides));
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
const out = (data, gym = gymA) => `${path(gym)}/${data.id}/check-out`;

test('admin records server-derived UTC attendance and leaves subscriptions/payments untouched', async () => {
  const token = await login(); const subscription = await create(token);
  const before = await models.MemberSubscription.findById(subscription.id).lean(); const started = Date.now();
  const data = await visit(token);
  assert.equal(data.memberId, String(memberA._id)); assert.equal(data.gymId, String(gymA._id));
  assert.equal(data.branchId, String(branchA._id)); assert.equal(data.subscriptionId, subscription.id);
  assert.equal(data.recordedByUserId, String(admin._id)); assert.equal(data.status, 'open');
  assert.equal(data.checkOutAt, null); assert.equal(data.durationMs, null);
  assert.ok(Date.parse(data.checkInAt) >= started && Date.parse(data.checkInAt) <= Date.now());
  assert.deepEqual(await models.MemberSubscription.findById(subscription.id).lean(), before);
  assert.equal(await models.Payment.countDocuments(), 0);
  assert.equal((await send('get', `${path()}/${data.id}`, token)).headers['cache-control'], 'no-store');
});

test('trainer can check in assigned member but cannot substitute an unrelated member', async () => {
  const adminToken = await login(); await create(adminToken); await create(adminToken, { memberId: String(memberOther._id) });
  const token = await login(trainer); const data = await visit(token);
  assert.equal(data.recordedByUserId, String(trainer._id));
  error(await send('post', `${path()}/check-in`, token, checkInInput({ memberId: String(memberOther._id) })), 404, 'MEMBER_NOT_FOUND');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 404, 'MEMBER_NOT_FOUND');
  assert.equal(await models.Attendance.countDocuments(), 1);
});

test('every endpoint requires authentication and denies member staff impersonation', async () => {
  const token = await login(); await create(token); const data = await visit(token); const memberToken = await login(member);
  for (const [method, url, body] of [['post', `${path()}/check-in`, checkInInput()], ['post', out(data), {}],
    ['get', path()], ['get', `${path()}/${data.id}`]]) {
    error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
    error(await send(method, url, memberToken, body), 403, 'FORBIDDEN');
  }
  assert.equal((await models.Attendance.findById(data.id)).status, 'open');
});

test('inactive/suspended members cannot check in despite valid membership', async () => {
  const token = await login(); await create(token);
  for (const status of ['inactive', 'suspended']) {
    await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { status } });
    error(await send('post', `${path()}/check-in`, token, checkInInput()), 403, 'FORBIDDEN');
  }
  assert.equal(await models.Attendance.countDocuments(), 0);
});

test('branch must be active, same gym and the member assigned branch', async () => {
  const token = await login(); await create(token);
  error(await send('post', `${path()}/check-in`, token, checkInInput({ branchId: String(branchB._id) })), 404, 'BRANCH_NOT_FOUND');
  error(await send('post', `${path()}/check-in`, token, checkInInput({ branchId: String(branchOther._id) })), 409, 'ATTENDANCE_BRANCH_MISMATCH');
  await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'inactive' } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_BRANCH_INACTIVE');
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $unset: { branchId: '' } });
  await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'active' } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_BRANCH_MISMATCH');
  assert.equal(await models.Attendance.countDocuments(), 0);
});

test('nonexistent/foreign members and nonexistent branches return safe not-found responses', async () => {
  const token = await login(); await create(token);
  for (const memberId of [missingId(), String(memberB._id)])
    error(await send('post', `${path()}/check-in`, token, checkInInput({ memberId })), 404, 'MEMBER_NOT_FOUND');
  error(await send('post', `${path()}/check-in`, token, checkInInput({ branchId: missingId() })), 404, 'BRANCH_NOT_FOUND');
});

test('no subscription, expired exclusive end and cancelled membership reject check-in', async () => {
  const token = await login();
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
  const expired = await create(token, { startDate: day(-30) }); assert.equal(expired.endDate, day());
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
  const current = await create(token);
  await send('patch', `${subscriptionPath()}/${current.id}/cancel`, token, {});
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
  assert.equal(await models.Attendance.countDocuments(), 0);
});

test('future active renewal never authorizes attendance; the current period is selected', async () => {
  const token = await login(); const current = await create(token);
  const future = await send('post', `${subscriptionPath()}/${current.id}/renew`, token, {});
  assert.equal(future.status, 201); assert.equal(future.body.data.isCurrentlyActive, false);
  const data = await visit(token); assert.equal(data.subscriptionId, current.id);
  await send('post', out(data), token, {});
  await send('patch', `${subscriptionPath()}/${current.id}/cancel`, token, {});
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
});

test('ambiguous overlapping current memberships and unknown lifecycle states fail closed', async () => {
  const token = await login(); const first = await create(token);
  const copy = await models.MemberSubscription.findById(first.id).lean(); delete copy._id;
  const second = await models.MemberSubscription.create(copy);
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_AMBIGUOUS');
  await models.MemberSubscription.deleteOne({ _id: second._id });
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { status: 'unexpected' } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_AMBIGUOUS');
  assert.equal(await models.Attendance.countDocuments(), 0);
});

test('historical subscription eligibility survives plan deactivation but rejects foreign reference corruption', async () => {
  const token = await login(); const first = await create(token);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { status: 'inactive', price: 180000 } });
  const data = await visit(token); assert.equal(data.subscriptionId, first.id); await send('post', out(data), token, {});
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { membershipPlanId: planB._id } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
});

test('second open visit conflicts and database partial unique index enforces the invariant', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_ALREADY_OPEN');
  const original = await models.Attendance.findById(data.id).lean(); delete original._id;
  await assert.rejects(models.Attendance.create(original), { code: 11000 });
  assert.equal(await models.Attendance.countDocuments({ status: 'open' }), 1);
});

test('simultaneous admin/trainer check-ins create exactly one open visit', async () => {
  const adminToken = await login(); await create(adminToken); const trainerToken = await login(trainer);
  const results = await Promise.all([send('post', `${path()}/check-in`, adminToken, checkInInput()),
    send('post', `${path()}/check-in`, trainerToken, checkInInput())]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  error(results.find((response) => response.status === 409), 409, 'ATTENDANCE_ALREADY_OPEN');
  assert.equal(await models.Attendance.countDocuments(), 1); assert.equal(await models.Attendance.countDocuments({ status: 'open' }), 1);
});

test('unique index rejects concurrent duplicates even when both application prechecks miss', async (t) => {
  const token = await login(); await create(token);
  t.mock.method(models.Attendance, 'exists', async () => null);
  const results = await Promise.all([send('post', `${path()}/check-in`, token, checkInInput()),
    send('post', `${path()}/check-in`, token, checkInInput())]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  error(results.find((response) => response.status === 409), 409, 'ATTENDANCE_ALREADY_OPEN');
  assert.equal(await models.Attendance.countDocuments(), 1);
});

test('admin closes a visit once with derived duration and can record a subsequent visit', async () => {
  const token = await login(); const subscription = await create(token); const data = await visit(token);
  const original = await models.MemberSubscription.findById(subscription.id).lean();
  const result = await send('post', out(data), token, {}); assert.equal(result.status, 200);
  const closed = result.body.data; assert.equal(closed.status, 'completed');
  assert.ok(Date.parse(closed.checkOutAt) >= Date.parse(closed.checkInAt));
  assert.equal(closed.durationMs, Date.parse(closed.checkOutAt) - Date.parse(closed.checkInAt));
  for (const field of ['gymId', 'memberId', 'branchId', 'subscriptionId', 'checkInAt', 'recordedByUserId']) assert.equal(closed[field], data[field]);
  const before = await models.Attendance.findById(data.id).lean();
  error(await send('post', out(data), token, {}), 409, 'ATTENDANCE_NOT_OPEN');
  assert.deepEqual(await models.Attendance.findById(data.id).lean(), before);
  await visit(token); assert.equal(await models.Attendance.countDocuments(), 2);
  assert.deepEqual(await models.MemberSubscription.findById(subscription.id).lean(), original);
});

test('concurrent check-outs complete exactly once and preserve the winning timestamp', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  const results = await Promise.all([send('post', out(data), token, {}), send('post', out(data), token, {})]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  const success = results.find((response) => response.status === 200);
  assert.equal((await models.Attendance.findById(data.id)).checkOutAt.toISOString(), success.body.data.checkOutAt);
});

test('trainer check-out requires current assignment and denies unrelated attendance', async () => {
  const adminToken = await login(); await create(adminToken); await create(adminToken, { memberId: String(memberOther._id) });
  const own = await visit(adminToken); const unrelated = await visit(adminToken, { memberId: String(memberOther._id) });
  const token = await login(trainer);
  error(await send('post', out(unrelated), token, {}), 404, 'ATTENDANCE_NOT_FOUND');
  assert.equal((await send('post', out(own), token, {})).status, 200);
  const another = await visit(adminToken);
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  error(await send('post', out(another), token, {}), 404, 'ATTENDANCE_NOT_FOUND');
});

test('closing and reading history remain possible after member/branch/subscription become inactive', async () => {
  const token = await login(); const subscription = await create(token); const data = await visit(token);
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { branchId: branchOther._id, status: 'suspended' } });
  await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'inactive' } });
  await send('patch', `${subscriptionPath()}/${subscription.id}/cancel`, token, {});
  const result = await send('post', out(data), token); assert.equal(result.status, 200);
  assert.equal(result.body.data.branchId, String(branchA._id)); assert.equal(result.body.data.subscriptionId, subscription.id);
  assert.equal((await send('get', `${path()}/${data.id}`, token)).status, 200);
});

test('plan edits and renewals never change historical attendance or collect money', async () => {
  const token = await login(); const subscription = await create(token); const data = await visit(token);
  const before = await models.Attendance.findById(data.id).lean();
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { price: 180000 } });
  assert.equal((await send('post', `${subscriptionPath()}/${subscription.id}/renew`, token, {})).status, 201);
  assert.deepEqual(await models.Attendance.findById(data.id).lean(), before);
  assert.deepEqual((await send('get', `${path()}/${data.id}`, token)).body.data, data);
  assert.equal(await models.Payment.countDocuments(), 0);
});

test('history pagination and validated date/member/branch/subscription/status filters are bounded', async () => {
  const token = await login(); const subscription = await create(token); const first = await visit(token);
  await send('post', out(first), token, {}); const second = await visit(token);
  const result = await send('get', `${path()}?limit=1&page=1`, token);
  assert.deepEqual(result.body.meta.pagination, { page: 1, limit: 1, total: 2 }); assert.equal(result.body.data[0].id, second.id);
  assert.equal((await send('get', `${path()}?limit=1&page=2`, token)).body.data[0].id, first.id);
  const query = `memberId=${memberA._id}&branchId=${branchA._id}&subscriptionId=${subscription.id}&status=completed&checkInFrom=${encodeURIComponent(first.checkInAt)}&checkInTo=${encodeURIComponent(second.checkInAt)}`;
  assert.deepEqual((await send('get', `${path()}?${query}`, token)).body.data.map((row) => row.id), [first.id]);
});

test('trainer history and filters cannot expand beyond active assigned members', async () => {
  const adminToken = await login(); const subscription = await create(adminToken);
  const otherSubscription = await create(adminToken, { memberId: String(memberOther._id) });
  const own = await visit(adminToken); const other = await visit(adminToken, { memberId: String(memberOther._id) });
  const token = await login(trainer); assert.deepEqual((await send('get', path(), token)).body.data, [own]);
  for (const filter of [`memberId=${memberOther._id}`, `subscriptionId=${otherSubscription.id}`, `branchId=${branchB._id}`]) {
    const response = await send('get', `${path()}?${filter}&page=1&limit=100`, token); assert.equal(response.status, 200);
    assert.equal(response.body.meta.pagination.total, 0);
  }
  error(await send('get', `${path()}/${other.id}`, token), 404, 'ATTENDANCE_NOT_FOUND');
  assert.equal((await send('get', `${path()}?subscriptionId=${subscription.id}`, token)).body.data[0].id, own.id);
});

test('cross-gym attendance IDOR is denied for reads and check-out even for multi-gym admin', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  error(await send('get', `${path(gymB)}/${data.id}`, token), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  error(await send('get', `${path(gymB)}/${data.id}`, token), 404, 'ATTENDANCE_NOT_FOUND');
  error(await send('post', out(data, gymB), token, {}), 404, 'ATTENDANCE_NOT_FOUND');
  await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  const foreign = await visit(token, { memberId: String(memberB._id), branchId: String(branchB._id) }, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'ATTENDANCE_NOT_FOUND');
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 1);
});

test('inactive grants/gyms and unlinked/inactive/ambiguous trainer profiles fail closed', async () => {
  const token = await login(); await create(token);
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } });
    error(await send('post', `${path()}/check-in`, token, checkInInput()), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'active' } });
  const trainerToken = await login(trainer);
  for (const status of ['inactive', 'suspended']) {
    await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status } });
    error(await send('get', path(), trainerToken), 403, 'FORBIDDEN');
  }
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'active' } });
  await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', userId: trainer._id, firstName: 'Other', lastName: 'Trainer', phone: '9876543211' });
  error(await send('get', path(), trainerToken), 403, 'FORBIDDEN');
  await models.TrainerProfile.collection.updateMany({ userId: trainer._id }, { $unset: { userId: '' } });
  error(await send('post', `${path()}/check-in`, trainerToken, checkInInput()), 403, 'FORBIDDEN');
});

test('strict check-in rejects protected fields, invalid IDs, operators and oversized payloads', async () => {
  const token = await login(); await create(token);
  for (const field of ['gymId', 'subscriptionId', 'checkInAt', 'checkOutAt', 'status', 'recordedByUserId', 'role', 'userId', 'notes', 'unknown'])
    error(await send('post', `${path()}/check-in`, token, checkInInput({ [field]: 'untrusted' })), 400, 'VALIDATION_ERROR');
  for (const body of [{}, { memberId: missingId() }, checkInInput({ memberId: 'invalid' }), checkInInput({ branchId: 'invalid' }),
    checkInInput({ memberId: { $ne: null } }), checkInInput({ branchId: ['invalid'] }), { $where: 'true' }])
    error(await send('post', `${path()}/check-in`, token, body), 400, 'VALIDATION_ERROR');
  error(await send('post', `${path()}/check-in`, token, checkInInput({ notes: 'x'.repeat(150000) })), 413, 'PAYLOAD_TOO_LARGE');
  assert.equal(await models.Attendance.countDocuments(), 0);
});

test('check-out rejects arbitrary timestamps, lifecycle changes and ownership substitution', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  for (const field of ['checkOutAt', 'checkInAt', 'status', 'gymId', 'memberId', 'branchId', 'subscriptionId', 'recordedByUserId'])
    error(await send('post', out(data), token, { [field]: missingId() }), 400, 'VALIDATION_ERROR');
  error(await send('patch', `${path()}/${data.id}`, token, { status: 'completed' }), 404, 'NOT_FOUND');
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  error(await send('post', `${path()}/${data.id}/cancel`, token, {}), 404, 'NOT_FOUND');
  assert.equal((await models.Attendance.findById(data.id)).status, 'open');
});

test('invalid list fields, status, date ranges, identifiers and pagination reject query injection', async () => {
  const token = await login();
  for (const suffix of ['memberId[$ne]=x', 'branchId[$ne]=x', 'subscriptionId[$ne]=x', '$where=true', 'role=admin',
    'trainerId=x', 'memberId=x', 'branchId=x', 'subscriptionId=x', 'status=invalid', 'page=0', 'limit=101',
    'page=10001', 'checkInFrom=bad', 'checkInFrom=2026-02-30T00:00:00Z',
    'checkInFrom=2026-10-08T00:00:00Z&checkInTo=2026-10-07T00:00:00Z', 'memberId=x&memberId=y'])
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('post', `${path()}/invalid/check-out`, token, {}), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'ATTENDANCE_NOT_FOUND');
});

test('completed records cannot be rewritten through model updates or document saves', async () => {
  const token = await login(); await create(token); const data = await visit(token); await send('post', out(data), token, {});
  const before = await models.Attendance.findById(data.id).lean();
  await assert.rejects(models.Attendance.updateOne({ _id: data.id }, { $set: { checkOutAt: new Date() } }));
  await assert.rejects(models.Attendance.findOneAndUpdate({ _id: data.id }, { $set: { status: 'open' } }));
  const doc = await models.Attendance.findById(data.id); doc.checkOutAt = new Date(); await assert.rejects(doc.save());
  await assert.rejects(models.Attendance.replaceOne({ _id: data.id }, before));
  assert.deepEqual(await models.Attendance.findById(data.id).lean(), before);
});

test('corrupt cross-gym or wrong-member references are excluded from history and check-out', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  const id = new mongoose.Types.ObjectId(data.id);
  for (const fields of [{ memberId: memberB._id }, { branchId: branchB._id }, { subscriptionId: new mongoose.Types.ObjectId() }]) {
    await models.Attendance.collection.updateOne({ _id: id }, { $set: fields });
    error(await send('get', `${path()}/${data.id}`, token), 404, 'ATTENDANCE_NOT_FOUND');
    error(await send('post', out(data), token, {}), 404, 'ATTENDANCE_NOT_FOUND');
    assert.equal((await send('get', path(), token)).body.meta.pagination.total, 0);
    await models.Attendance.collection.updateOne({ _id: id }, { $set: { memberId: memberA._id, branchId: branchA._id,
      subscriptionId: new mongoose.Types.ObjectId(data.subscriptionId) } });
  }
});

test('lookup/write failures fail closed without partial visits or private error leakage', async (t) => {
  const token = await login(); await create(token);
  for (const [model, method] of [[models.GymAccess, 'findOne'], [models.Gym, 'findOne'], [models.MemberProfile, 'findOne'],
    [models.Branch, 'findOne'], [models.MemberSubscription, 'find'], [models.MembershipPlan, 'exists'],
    [models.Attendance, 'exists'], [models.Attendance, 'create']]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database credentials'); });
    const response = await send('post', `${path()}/check-in`, token, checkInInput());
    error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
    mocked.mock.restore(); assert.equal(await models.Attendance.countDocuments(), 0);
  }
  const data = await visit(token);
  for (const [model, method, verb, url] of [[models.Attendance, 'aggregate', 'get', `${path()}/${data.id}`],
    [models.Attendance, 'findOneAndUpdate', 'post', out(data)]]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database credentials'); });
    error(await send(verb, url, token, verb === 'post' ? {} : undefined), 500, 'INTERNAL_SERVER_ERROR'); mocked.mock.restore();
  }
  assert.equal((await models.Attendance.findById(data.id)).status, 'open');
});

test('service rejects missing/stale gym authorization on all entry points', async () => {
  const token = await login(); await create(token); const data = await visit(token); const { auth, authorization } = await context();
  const calls = [(selected) => service().checkIn(auth, selected, checkInInput()), (selected) => service().checkOut(auth, selected, data.id, {}),
    (selected) => service().get(auth, selected, data.id), (selected) => service().list(auth, selected, { page: 1, limit: 20 })];
  for (const call of calls) await assert.rejects(call(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  for (const call of calls) await assert.rejects(call(authorization), { code: 'FORBIDDEN' });
});

test('attendance bootstrap mounting does not provide an unauthenticated alternate route', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(`${path()}/check-in`).send(checkInInput()), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', '/api/v1/attendance', await login())).status, 404);
});

test('startup installs attendance indexes additively including the open-session invariant', async () => {
  await models.Attendance.collection.dropIndexes();
  await models.Attendance.collection.createIndex({ recordedByUserId: 1 }, { name: 'retained_attendance_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.Attendance.listIndexes();
    assert.ok(indexes.some((index) => index.name === 'retained_attendance_index'));
    const unique = indexes.find((index) => index.name === 'attendance_open_member_unique');
    assert.equal(unique.unique, true); assert.deepEqual(unique.partialFilterExpression, { status: 'open' });
    assert.deepEqual(unique.key, { gymId: 1, memberId: 1 });
    assert.equal(models.Attendance.schema.path('durationMs'), undefined);
  } finally { await lifecycle.shutdown('test'); }
});

test('trainer profile/assignment lookup failures fail closed before creating attendance', async (t) => {
  const token = await login(); await create(token); const trainerToken = await login(trainer);
  for (const [model, method] of [[models.TrainerProfile, 'find'], [models.TrainerMemberAssignment, 'exists']]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private assignment details'); });
    const response = await send('post', `${path()}/check-in`, trainerToken, checkInInput());
    error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
    mocked.mock.restore(); assert.equal(await models.Attendance.countDocuments(), 0);
  }
});

test('corrupted predecessor linkage cannot authorize attendance through a current renewal', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-30) });
  const renewed = await send('post', `${subscriptionPath()}/${first.id}/renew`, token, {});
  assert.equal(renewed.status, 201);
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(renewed.body.data.id) },
    { $set: { previousSubscriptionId: new mongoose.Types.ObjectId() } });
  error(await send('post', `${path()}/check-in`, token, checkInInput()), 409, 'ATTENDANCE_MEMBERSHIP_REQUIRED');
  assert.equal(await models.Attendance.countDocuments(), 0);
});
