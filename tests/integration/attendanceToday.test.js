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
function service(instant) {
  return createAttendanceService({ ...models, authorizationService: createAuthorizationService(models), ...(instant ? { clock: () => new Date(instant) } : {}) });
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

const todayPath = (gym = gymA) => `${path(gym)}/today`;
async function today(token, query = '') {
  const response = await send('get', todayPath() + query, token);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
async function seed({ person = memberA, branch = branchA, gym = gymA, plan = planA, at = new Date(), status = 'completed' } = {}) {
  const start = new Date(`${day(-1)}T00:00:00Z`); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 30);
  const sub = await models.MemberSubscription.create({ gymId: gym._id, memberId: person._id, membershipPlanId: plan._id,
    startDate: start, endDate: end, planNameSnapshot: 'Monthly', durationDaysSnapshot: 30, pricePaiseSnapshot: 150000 });
  return models.Attendance.create({ gymId: gym._id, memberId: person._id, branchId: branch._id, subscriptionId: sub._id,
    recordedByUserId: admin._id, checkInAt: new Date(at), status,
    ...(status === 'completed' ? { checkOutAt: new Date(new Date(at).getTime() + 3600000) } : {}) });
}
async function fixed(instant) {
  await login(); const { auth, authorization } = await context();
  return service(instant).today(auth, authorization, { page: 1, limit: 20 });
}
test('admin receives mixed visit summary and explicitly allowlisted staff fields', async () => {
  const token = await login(); await seed(); await seed(); await seed({ person: memberOther, status: 'open' });
  await seed({ status: 'cancelled' });
  const response = await today(token); const data = response.data;
  assert.deepEqual(data.summary, { totalVisits: 3, completedVisits: 2, currentlyCheckedIn: 1, uniqueMembers: 2 });
  assert.equal(data.date, day()); assert.equal(data.timezone, 'UTC');
  assert.deepEqual(response.meta.pagination, { page: 1, limit: 20, total: 3 });
  for (const row of data.visits) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'memberId', 'memberCode', 'memberName', 'branchId', 'branchName', 'subscriptionId', 'checkInAt', 'checkOutAt', 'status', 'durationMs'].sort());
    assert.equal(row.memberName, 'Alex River'); assert.equal(row.branchName, 'Main');
    assert.equal(row.durationMs, row.status === 'open' ? null : 3600000);
    if (row.status === 'open') assert.equal(row.checkOutAt, null);
  }
  assert.doesNotMatch(JSON.stringify(data), /password|token|email|phone|recordedByUserId|createdAt|updatedAt|__v/i);
});
test('empty day returns zero summary and bounded empty visits', async () => {
  const response = await today(await login());
  assert.deepEqual(response.data.summary, { totalVisits: 0, completedVisits: 0, currentlyCheckedIn: 0, uniqueMembers: 0 });
  assert.deepEqual(response.data.visits, []); assert.equal(response.meta.pagination.total, 0);
});
test('real check-in/out appear without changing existing attendance lifecycle', async () => {
  const token = await login(); await create(token); const opened = await visit(token);
  const response = await send('get', todayPath(), token); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
  assert.equal(response.body.data.summary.currentlyCheckedIn, 1);
  assert.equal((await send('post', out(opened), token, {})).status, 200);
  assert.equal((await today(token)).data.summary.completedVisits, 1);
});
test('trainer sees only actively assigned members, including summary counts', async () => {
  const own = await seed(); await seed({ person: memberOther });
  const result = await today(await login(trainer));
  assert.deepEqual(result.data.visits.map((row) => row.id), [String(own._id)]);
  assert.deepEqual(result.data.summary, { totalVisits: 1, completedVisits: 1, currentlyCheckedIn: 0, uniqueMembers: 1 });
});
test('assignment revocation removes trainer access and new assignment grants history', async () => {
  await seed(); await seed({ person: memberOther }); const token = await login(trainer);
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { status: 'inactive' });
  assert.equal((await today(token)).data.summary.totalVisits, 0);
  await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberOther._id });
  assert.deepEqual((await today(token)).data.visits.map((row) => row.memberId), [String(memberOther._id)]);
});
test('trainer member and branch filters cannot expand scope', async () => {
  await seed(); await seed({ person: memberOther, branch: branchOther }); const token = await login(trainer);
  error(await send('get', todayPath() + `?memberId=${memberOther._id}&page=2&limit=100&status=completed`, token), 404, 'MEMBER_NOT_FOUND');
  const narrowed = await today(token, `?branchId=${branchOther._id}&page=1&limit=100&status=completed`);
  assert.equal(narrowed.data.summary.totalVisits, 0); assert.deepEqual(narrowed.data.visits, []);
  assert.equal((await today(token, `?memberId=${memberA._id}&status=completed`)).data.summary.totalVisits, 1);
});
for (const condition of ['missing', 'inactive', 'ambiguous']) test(`${condition} trainer profile fails closed`, async () => {
  const token = await login(trainer);
  if (condition === 'missing') await models.TrainerProfile.deleteOne({ _id: trainerA._id });
  if (condition === 'inactive') await models.TrainerProfile.updateOne({ _id: trainerA._id }, { status: 'inactive' });
  if (condition === 'ambiguous') await models.TrainerProfile.create({ gymId: gymA._id, userId: trainer._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543210' });
  error(await send('get', todayPath(), token), 403, 'FORBIDDEN');
});
test('members and unauthenticated clients denied', async () => {
  error(await send('get', todayPath(), await login(member)), 403, 'FORBIDDEN');
  error(await send('get', todayPath()), 401, 'INVALID_AUTHENTICATION');
});
test('cross-gym access and foreign source records cannot leak', async () => {
  await seed({ gym: gymB, person: memberB, branch: branchB, plan: planB }); const token = await login();
  error(await send('get', todayPath(gymB), token), 403, 'FORBIDDEN');
  assert.equal((await today(token)).data.summary.totalVisits, 0);
  await models.GymAccess.create({ gymId: gymB._id, userId: admin._id, role: 'admin', status: 'active' });
  assert.equal((await send('get', todayPath(gymB), token)).body.data.summary.totalVisits, 1);
});
for (const status of ['inactive', 'suspended']) test(`${status} gym grant denies operations`, async () => {
  const token = await login(); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  error(await send('get', todayPath(), token), 403, 'FORBIDDEN');
});
test('inactive gym denied', async () => {
  const token = await login(); await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  error(await send('get', todayPath(), token), 403, 'FORBIDDEN');
});
test('unknown fields, trainer impersonation, invalid IDs/status and pagination rejected', async () => {
  const token = await login(trainer);
  for (const query of ['trainerId='+trainerA._id, 'role=admin', 'gymId='+gymB._id, 'userId='+admin._id,
    'memberId=bad', 'branchId=bad', 'memberId[$ne]=x', 'branchId[$ne]=x', '$where=true', 'status=cancelled', 'status=invalid',
    'page=0', 'page=10001', 'limit=101', 'limit=0', 'page=1.5', 'page=-1', 'memberId=x&memberId=y', 'from=2026-10-07', 'subscriptionId='+missingId()]) {
    error(await send('get', todayPath()+'?'+query, token), 400, 'VALIDATION_ERROR');
  }
  error(await send('get', '/api/v1/gyms/bad/attendance/today', token), 400, 'VALIDATION_ERROR');
});
test('foreign/missing branches and members rejected within authorized gym', async () => {
  const token = await login();
  for (const id of [String(branchB._id), missingId()]) error(await send('get', todayPath()+`?branchId=${id}`, token), 404, 'BRANCH_NOT_FOUND');
  for (const id of [String(memberB._id), missingId()]) error(await send('get', todayPath()+`?memberId=${id}`, token), 404, 'MEMBER_NOT_FOUND');
});
test('filters narrow both rows and summary', async () => {
  await seed(); await seed({ person: memberOther, branch: branchOther, status: 'open' });
  const token = await login();
  const completed = await today(token, '?status=completed');
  assert.deepEqual(completed.data.summary, { totalVisits: 1, completedVisits: 1, currentlyCheckedIn: 0, uniqueMembers: 1 });
  const open = await today(token, `?status=open&branchId=${branchOther._id}&memberId=${memberOther._id}`);
  assert.deepEqual(open.data.summary, { totalVisits: 1, completedVisits: 0, currentlyCheckedIn: 1, uniqueMembers: 1 });
});
test('pagination is stable, summaries are not page totals', async () => {
  const at = new Date(); const first = await seed({ at }); const second = await seed({ at }); const third = await seed({ at });
  const token = await login(); const ids = [first, second, third].map((record) => String(record._id)).sort().reverse();
  for (let page = 1; page <= 3; page++) {
    const response = await today(token, `?page=${page}&limit=1`);
    assert.equal(response.data.summary.totalVisits, 3); assert.equal(response.data.summary.uniqueMembers, 1);
    assert.deepEqual(response.meta.pagination, { page, limit: 1, total: 3 });
    assert.equal(response.data.visits[0].id, ids[page-1]);
  }
  const empty = await today(token, '?page=10000&limit=100');
  assert.deepEqual(empty.data.visits, []); assert.equal(empty.data.summary.totalVisits, 3);
});
test('history remains visible after inactive member/branch, cancelled subscription and branch transfer', async () => {
  const record = await seed(); const token = await login();
  await models.MemberProfile.updateOne({ _id: memberA._id }, { status: 'inactive', branchId: branchOther._id });
  await models.Branch.updateOne({ _id: branchA._id }, { status: 'inactive' });
  await models.MemberSubscription.updateOne({ _id: record.subscriptionId }, { status: 'cancelled' });
  const result = await today(token, `?branchId=${branchA._id}`);
  assert.equal(result.data.summary.totalVisits, 1); assert.equal(result.data.visits[0].branchId, String(branchA._id));
  assert.equal((await today(token, `?branchId=${branchOther._id}`)).data.summary.totalVisits, 0);
  assert.equal((await today(await login(trainer), `?branchId=${branchA._id}`)).data.summary.totalVisits, 1);
});
test('gym-local window includes start and excludes end, ignores updatedAt and old open visits', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  for (const at of ['2026-10-07T18:29:59.999Z', '2026-10-07T18:30:00Z', '2026-10-08T18:29:59.999Z', '2026-10-08T18:30:00Z']) await seed({ at });
  await seed({ person: memberOther, at: '2026-10-06T00:00Z', status: 'open' });
  const result = await fixed('2026-10-07T20:00:00Z');
  assert.equal(result.data.date, '2026-10-08'); assert.equal(result.data.timezone, 'Asia/Kolkata');
  assert.equal(result.data.summary.totalVisits, 2); assert.equal(result.data.summary.currentlyCheckedIn, 0);
});
for (const [instant, start, end] of [['2026-03-08T12:00:00Z', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
  ['2026-11-01T12:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z']]) test(`DST operational day ${instant} uses correct UTC boundaries`, async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'America/New_York' });
  await seed({ at: new Date(new Date(start).getTime()-1) }); await seed({ at: start });
  await seed({ at: new Date(new Date(end).getTime()-1) }); await seed({ at: end });
  assert.equal((await fixed(instant)).data.summary.totalVisits, 2);
});
test('corrupt foreign/missing references are excluded from both visits and summary', async () => {
  const record = await seed(); const token = await login();
  for (const fields of [{ memberId: memberB._id }, { memberId: new mongoose.Types.ObjectId() },
    { branchId: branchB._id }, { branchId: new mongoose.Types.ObjectId() }, { subscriptionId: new mongoose.Types.ObjectId() }]) {
    await models.Attendance.collection.updateOne({ _id: record._id }, { $set: fields });
    const result = await today(token); assert.equal(result.data.summary.totalVisits, 0); assert.deepEqual(result.data.visits, []);
    await models.Attendance.collection.updateOne({ _id: record._id }, { $set: { memberId: memberA._id, branchId: branchA._id, subscriptionId: record.subscriptionId } });
  }
});
test('invalid display/lifecycle data fails safely instead of returning malformed visits', async () => {
  const record = await seed(); const token = await login();
  await models.Attendance.collection.updateOne({ _id: record._id }, { $unset: { checkOutAt: '' } });
  error(await send('get', todayPath(), token), 500, 'INTERNAL_SERVER_ERROR');
});
test('all authorization/timezone/aggregation lookup failures fail closed', async (t) => {
  const token = await login(); const trainerToken = await login(trainer);
  for (const [model, method, query, selected] of [[models.GymAccess, 'findOne', '', token], [models.Gym, 'findOne', '', token],
    [models.Gym, 'aggregate', '', token], [models.Branch, 'exists', `?branchId=${branchA._id}`, token],
    [models.MemberProfile, 'exists', `?memberId=${memberA._id}`, token], [models.TrainerProfile, 'find', '', trainerToken],
    [models.TrainerMemberAssignment, 'exists', `?memberId=${memberA._id}`, trainerToken], [models.Attendance, 'aggregate', '', token]]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private database diagnostics'); });
    const response = await send('get', todayPath()+query, selected); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(response.body.data, undefined); assert.doesNotMatch(JSON.stringify(response.body), /private database diagnostics/);
    mock.mock.restore();
  }
});
test('invalid timezone fails safely and absent timezone follows UTC fallback', async () => {
  assert.equal((await today(await login())).data.timezone, 'UTC');
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Invalid/Zone' });
  error(await send('get', todayPath(), await login()), 500, 'INTERNAL_SERVER_ERROR');
});
test('service rejects incomplete and stale gym scope', async () => {
  await login(); const { auth, authorization } = await context();
  for (const scope of [undefined, { ...authorization, gymId: undefined }, { ...authorization, role: 'member' }])
    await assert.rejects(service().today(auth, scope, { page: 1, limit: 20 }), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { role: 'member' });
  await assert.rejects(service().today(auth, authorization, { page: 1, limit: 20 }), { code: 'FORBIDDEN' });
});
test('bootstrap listener has no unauthenticated operational bypass', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).get(todayPath()), 401, 'INVALID_AUTHENTICATION');
});
test('operational requests use constant queries, no writes or new collections', async (t) => {
  await seed(); const token = await login();
  const snapshot = async () => JSON.stringify(await Promise.all(Object.values(models).map((model) => model.find().sort('_id').lean())));
  const before = await snapshot(); let queries = 0; const original = models.Attendance.aggregate;
  t.mock.method(models.Attendance, 'aggregate', function (...args) { queries++; return original.apply(this, args); });
  for (const model of Object.values(models)) for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite'])
    t.mock.method(model, method, () => { throw new Error('Read attempted write'); });
  await today(token); assert.equal(queries, 1); assert.equal(await snapshot(), before);
  assert.equal(Object.keys(models).some((name) => /today|dashboard/i.test(name)), false);
});
