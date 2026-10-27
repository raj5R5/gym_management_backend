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
const { createApp: createRuntimeApp } = require('../../src/app');
const { historicalRecords } = require('../helpers/historicalRecords');
const createApp = (options) => { const app = createRuntimeApp(options); historicalRecords(options.database?.connection); return app; };
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createDashboardService } = require('../../src/modules/gymDashboard/dashboard.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, branchA, branchOther, branchB;
const password = randomBytes(24).toString('base64url');
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
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
  return createDashboardService({ ...models, authorizationService: createAuthorizationService(models),
    ...(instant ? { clock: () => new Date(instant) } : {}) });
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
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', branchId: branchA._id, userId: trainer._id });
  await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});



const dashboardPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/dashboard`;
async function dashboard(token, query = '', gym = gymA) {
  const response = await send('get', dashboardPath(gym) + query, token);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
}
async function payment(token, subscription, amountPaise, overrides = {}) {
  const response = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token, {
    memberId: subscription.memberId, subscriptionId: subscription.id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date().toISOString(), ...overrides });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}

async function period(start, days, overrides = {}) {
  const end = new Date(`${start}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + days);
  return models.MemberSubscription.create({ gymId: gymA._id, memberId: memberA._id, membershipPlanId: planA._id,
    startDate: new Date(`${start}T00:00:00Z`), endDate: end, durationDaysSnapshot: days,
    pricePaiseSnapshot: 150000, planNameSnapshot: 'Monthly', ...overrides });
}
async function historicalVisit(sub, at, overrides = {}) {
  return models.Attendance.create({ gymId: gymA._id, memberId: sub.memberId, subscriptionId: sub._id,
    branchId: branchA._id, recordedByUserId: admin._id, checkInAt: new Date(at),
    checkOutAt: new Date(new Date(at).getTime() + 3600000), status: 'completed', ...overrides });
}
async function fixed(instant, query = {}) {
  await login(); const { auth, authorization } = await context();
  return service(instant).get(auth, authorization, query);
}
test('admin gets profile counts and zero financial/attendance metrics, without secrets', async () => {
  const response = await send('get', dashboardPath(), await login()); assert.equal(response.status, 200);
  const data = response.body.data;
  assert.deepEqual(data.members, { total: 2, active: 2, inactive: 0, suspended: 0 });
  assert.deepEqual(data.trainers, { total: 1, active: 1, inactive: 0, suspended: 0 });
  assert.deepEqual(data.subscriptions, { currentlyActive: 0, expiringSoon: 0, expired: 0 });
  assert.deepEqual(data.payments, { periodSuccessfulAmountPaise: 0, periodSuccessfulCount: 0, outstandingAmountPaise: 0 });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
  assert.deepEqual(Object.keys(data).sort(), ['members', 'payments', 'period', 'subscriptions', 'trainers']);
  assert.doesNotMatch(JSON.stringify(data), /password|token|email|firstName|memberId|userId|_id/i);
});
test('empty gym returns zero metrics', async () => {
  await models.GymAccess.create({ gymId: gymB._id, userId: admin._id, role: 'admin', status: 'active' });
  await models.MemberProfile.deleteOne({ _id: memberB._id });
  const data = await dashboard(await login(), '', gymB);
  assert.equal(data.members.total, 0); assert.equal(data.trainers.total, 0); assert.equal(data.payments.periodSuccessfulCount, 0);
});
for (const role of ['trainer', 'member']) test(`${role} is denied`, async () => {
  error(await send('get', dashboardPath(), await login(role === 'trainer' ? trainer : member)), 403, 'FORBIDDEN');
});
test('anonymous request denied', async () => { error(await send('get', dashboardPath()), 401, 'INVALID_AUTHENTICATION'); });
test('cross gym denied even with valid date filters', async () => {
  error(await send('get', dashboardPath(gymB) + `?from=2026-03-01`, await login()), 403, 'FORBIDDEN');
});
for (const status of ['inactive', 'suspended']) test(`${status} GymAccess denied`, async () => {
  const token = await login(); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  error(await send('get', dashboardPath(), token), 403, 'FORBIDDEN');
});
test('inactive gym denied', async () => {
  const token = await login(); await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  error(await send('get', dashboardPath(), token), 403, 'FORBIDDEN');
});
test('status counts use all gym profiles, including inactive/suspended', async () => {
  await models.MemberProfile.updateOne({ _id: memberA._id }, { status: 'inactive' });
  await models.MemberProfile.updateOne({ _id: memberOther._id }, { status: 'suspended', branchId: branchOther._id });
  const person = { firstName: 'Test', lastName: 'Trainer', phone: '9876543210', gymId: gymA._id };
  await models.TrainerProfile.create({ ...person, trainerCode: 'TR02', status: 'inactive', branchId: branchA._id });
  await models.TrainerProfile.create({ ...person, trainerCode: 'TR03', status: 'suspended', branchId: branchOther._id });
  const token = await login(); const all = await dashboard(token);
  assert.deepEqual(all.members, { total: 2, active: 0, inactive: 1, suspended: 1 });
  assert.deepEqual(all.trainers, { total: 3, active: 1, inactive: 1, suspended: 1 });
});


test('strict identifiers, dates, unknown parameters and MongoDB operators rejected', async () => {
  const token = await login();
  for (const query of ['?branchId=bad', '?from=2026-02-30', '?from=2026-2-01', '?from=2026-01-01T00:00:00Z',
    '?from=2026-03-02&to=2026-03-01', '?from=2025-01-01&to=2026-01-02', '?gymId=anything', '?role=admin', '?from[$gt]=2026-01-01', '?branchId[$ne]=null', '?from=a&from=b']) {
    error(await send('get', dashboardPath() + query, token), 400, 'VALIDATION_ERROR');
  }
  error(await send('get', '/api/v1/gyms/bad/dashboard', token), 400, 'VALIDATION_ERROR');
});
test('366 inclusive calendar days allowed and 367 rejected', async () => {
  const token = await login();
  await dashboard(token, '?from=2024-01-01&to=2024-12-31');
  error(await send('get', dashboardPath() + '?from=2024-01-01&to=2025-01-01', token), 400, 'VALIDATION_ERROR');
});
test('UTC fallback, gym-local default and single-sided day ranges are explicit', async () => {
  const utc = await fixed('2026-10-07T20:00:00Z'); assert.equal(utc.period.from, '2026-10-07'); assert.equal(utc.period.timezone, 'UTC');
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  const data = await fixed('2026-10-07T20:00:00Z');
  assert.equal(data.period.from, '2026-10-08'); assert.equal(data.period.to, '2026-10-08');
  assert.equal(data.period.startUtc, '2026-10-07T18:30:00.000Z'); assert.equal(data.period.endUtc, '2026-10-08T18:30:00.000Z');
  const single = await fixed('2026-10-07T20:00:00Z', { to: '2026-03-01' });
  assert.equal(single.period.from, '2026-03-01'); assert.equal(single.period.to, '2026-03-01');
});
for (const [date, start, end] of [['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
  ['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']]) test(`DST ${date} uses local calendar boundaries`, async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'America/New_York' });
  const data = await fixed('2026-10-07T12:00:00Z', { from: date, to: date });
  assert.equal(data.period.startUtc, start); assert.equal(data.period.endUtc, end);
});
test('quarter-hour timezone handled', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kathmandu' });
  const data = await fixed('2026-10-07T20:00:00Z'); assert.equal(data.period.startUtc, '2026-10-07T18:15:00.000Z');
});
test('current and expiring subscriptions use gym calendar labels and ignore plan status', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  await period('2026-10-01', 7); // ended on local today, excluded from current
  await period('2026-10-08', 7, { memberId: memberOther._id }); // current, ends exactly +7
  await period('2026-10-16', 30); // future
  await period('2026-10-01', 30, { status: 'cancelled' });
  await models.MembershipPlan.updateOne({ _id: planA._id }, { status: 'inactive' });
  const data = await fixed('2026-10-07T20:00:00Z', { from: '2026-03-01', to: '2026-03-01' });
  assert.deepEqual(data.subscriptions, { currentlyActive: 1, expiringSoon: 1, expired: 1 });
});
test('expiring window excludes current subscriptions ending more than seven days away', async () => {
  await period('2026-10-01', 14); await period('2026-10-01', 15, { memberId: memberOther._id });
  const data = await fixed('2026-10-08T12:00:00Z');
  assert.deepEqual(data.subscriptions, { currentlyActive: 2, expiringSoon: 1, expired: 0 });
});
test('ambiguous overlapping current subscriptions fail closed', async () => {
  await period('2026-10-01', 30); await period('2026-10-02', 30);
  await assert.rejects(() => fixed('2026-10-08T12:00:00Z'), { code: 'INVALID_DASHBOARD_STATE' });
});
test('paidAt controls inclusive local boundaries, exact paise and unsuccessful exclusion', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  const sub = await period('2026-03-01', 30); const token = await login();
  const dto = { id: String(sub._id), memberId: String(sub.memberId) };
  await payment(token, dto, 101, { paidAt: '2026-02-28T18:30:00Z' });
  await payment(token, dto, 202, { paidAt: '2026-03-01T18:29:59.999Z' });
  await payment(token, dto, 404, { paidAt: '2026-03-01T18:30:00Z' });
  await payment(token, dto, 808, { paidAt: '2026-02-28T18:29:59.999Z' });
  for (const status of ['failed', 'pending', 'cancelled']) await models.Payment.create({ gymId: gymA._id, memberId: memberA._id,
    subscriptionId: sub._id, amountPaise: 999, paymentMethod: 'cash', paidAt: new Date('2026-03-01T00:00Z'), status });
  const data = await dashboard(token, '?from=2026-03-01&to=2026-03-01');
  assert.deepEqual(data.payments, { periodSuccessfulAmountPaise: 303, periodSuccessfulCount: 2, outstandingAmountPaise: 148485 });
});
test('invalid stored financial values and overflowing totals fail closed', async () => {
  const sub = await period('2026-03-01', 30);
  const record = await models.Payment.create({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub._id,
    amountPaise: 100, paymentMethod: 'cash', paidAt: new Date('2026-03-01T00:00Z') });
  await models.Payment.collection.updateOne({ _id: record._id }, { $set: { amountPaise: 1.5 } });
  error(await send('get', dashboardPath() + '?from=2026-03-01', await login()), 500, 'INTERNAL_SERVER_ERROR');
  const original = models.Payment.aggregate;
  models.Payment.aggregate = async () => [{ amount: mongoose.Types.Decimal128.fromString('9007199254740992'), total: 1, invalid: 0 }];
  try { error(await send('get', dashboardPath(), await login()), 500, 'INTERNAL_SERVER_ERROR'); }
  finally { models.Payment.aggregate = original; }
});




test('foreign and broken member/subscription/plan/branch references are never attributed', async () => {
  const valid = await period('2026-03-01', 30);
  await period('2026-03-01', 30, { memberId: memberB._id });
  await period('2026-03-01', 30, { memberId: new mongoose.Types.ObjectId() });
  await period('2026-03-01', 30, { membershipPlanId: planB._id });
  for (const memberId of [memberB._id, new mongoose.Types.ObjectId()]) await models.Payment.create({ gymId: gymA._id,
    memberId, subscriptionId: valid._id, amountPaise: 500, paymentMethod: 'cash', paidAt: new Date('2026-03-01T00:00Z') });
  await historicalVisit(valid, '2026-03-01T00:00Z', { branchId: branchB._id });
  await historicalVisit(valid, '2026-03-01T01:00Z', { subscriptionId: new mongoose.Types.ObjectId() });
  const data = await fixed('2026-03-10T12:00:00Z', { from: '2026-03-01' });
  assert.equal(data.payments.outstandingAmountPaise, 150000);
});
test('dashboard is read-only, performs fixed aggregation count, and has no dashboard collection', async () => {
  const token = await login(); const snapshot = async () => JSON.stringify(await Promise.all(Object.values(models).map((model) => model.find().sort('_id').lean())));
  const before = await snapshot(); const restores = []; let aggregations = 0;
  for (const model of Object.values(models)) for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite']) {
    const original = model[method]; model[method] = () => { throw new Error('Dashboard attempted a write'); };
    restores.push(() => { model[method] = original; });
  }
  for (const name of ['Gym', 'MemberProfile', 'TrainerProfile', 'MemberSubscription', 'Payment', 'Attendance']) {
    const model = models[name]; const original = model.aggregate;
    model.aggregate = function (...args) { aggregations++; return original.apply(this, args); }; restores.push(() => { model.aggregate = original; });
  }
  try { await dashboard(token); assert.equal(aggregations, 6); assert.equal(await snapshot(), before); }
  finally { restores.forEach((restore) => restore()); }
  assert.equal(Object.keys(models).some((name) => /dashboard/i.test(name)), false);
});
test('database failure returns safe error and no partial dashboard', async () => {
  const token = await login(); const original = models.Payment.aggregate;
  models.Payment.aggregate = async () => { throw new Error('private database diagnostics'); };
  try { const response = await send('get', dashboardPath(), token); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(response.body.data, undefined); assert.doesNotMatch(JSON.stringify(response.body), /private database diagnostics/); }
  finally { models.Payment.aggregate = original; }
});
test('invalid persisted timezone fails safely', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Invalid/Zone' });
  error(await send('get', dashboardPath(), await login()), 500, 'INTERNAL_SERVER_ERROR');
});
test('other gym source records excluded from every operational metric', async () => {
  const foreign = await period('2026-03-01', 30, { gymId: gymB._id, memberId: memberB._id, membershipPlanId: planB._id });
  await models.Payment.create({ gymId: gymB._id, memberId: memberB._id, subscriptionId: foreign._id,
    amountPaise: 123456, paymentMethod: 'cash', paidAt: new Date('2026-03-01T00:00Z') });
  await historicalVisit(foreign, '2026-03-01T00:00Z', { gymId: gymB._id, branchId: branchB._id });
  await historicalVisit(foreign, '2026-03-02T00:00Z', { gymId: gymB._id, branchId: branchB._id, status: 'open', checkOutAt: undefined });
  const data = await fixed('2026-03-10T12:00:00Z', { from: '2026-03-01' });
  assert.equal(data.members.total, 2); assert.equal(data.subscriptions.currentlyActive, 0);
});
test('service revalidates access and cannot trust a stale admin authorization context', async () => {
  await login(); const { auth, authorization } = await context();
  await models.GymAccess.updateOne({ userId: admin._id }, { role: 'trainer' });
  await assert.rejects(() => service().get(auth, authorization, {}), { code: 'FORBIDDEN' });
});
test('midnight DST transition resolves to the first instant of the local day', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'America/Santiago' });
  const data = await fixed('2026-10-07T12:00:00Z', { from: '2026-09-06' });
  assert.equal(data.period.startUtc, '2026-09-06T04:00:00.000Z');
  assert.equal(data.period.endUtc, '2026-09-07T03:00:00.000Z');
});
test('historically skipped calendar day is rejected rather than querying another day', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Pacific/Apia' });
  error(await send('get', dashboardPath() + '?from=2011-12-30', await login()), 400, 'VALIDATION_ERROR');
});

// Outstanding balance is a stock metric, distinct from period revenue.
test('dashboard shows saved plan price less partial payment separately from revenue', async () => {
  const token = await login(); const sub = await create(token);
  await payment(token, sub, 100000);
  const data = await dashboard(token);
  assert.deepEqual(data.payments, { periodSuccessfulAmountPaise: 100000, periodSuccessfulCount: 1, outstandingAmountPaise: 50000 });
  const history = await send('get', `/api/v1/gyms/${gymA._id}/members/${memberA._id}/memberships/${sub.id}`, token);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.paymentSummary.remainingBalancePaise, data.payments.outstandingAmountPaise);
});
test('multiple members, installments and renewal periods do not multiply outstanding dues', async () => {
  const token = await login();
  const first = await period('2026-01-01', 30);
  const renewal = await period('2026-02-01', 30, { previousSubscriptionId: first._id });
  const other = await period('2026-01-01', 30, { memberId: memberOther._id });
  await payment(token, { id: String(first._id), memberId: String(first.memberId) }, 30001);
  await payment(token, { id: String(first._id), memberId: String(first.memberId) }, 69999);
  await payment(token, { id: String(renewal._id), memberId: String(renewal.memberId) }, 150000);
  await payment(token, { id: String(other._id), memberId: String(other.memberId) }, 40003);
  assert.equal((await dashboard(token)).payments.outstandingAmountPaise, 159997);
});
test('dues include unpaid expired and future subscriptions but exclude cancelled and free plans', async () => {
  const token = await login();
  await period('2020-01-01', 30);
  await period('2090-01-01', 30, { memberId: memberOther._id });
  await period('2020-02-01', 30, { status: 'cancelled' });
  await period('2020-03-01', 30, { pricePaiseSnapshot: 0 });
  await models.MemberProfile.updateOne({ _id: memberA._id }, { status: 'inactive' });
  await models.MembershipPlan.updateOne({ _id: planA._id }, { price: 999999 });
  assert.equal((await dashboard(token)).payments.outstandingAmountPaise, 300000);
});
test('dues use all successful payments regardless of selected period and ignore unsuccessful payments', async () => {
  const token = await login(); const sub = await period('2026-01-01', 30);
  await payment(token, { id: String(sub._id), memberId: String(sub.memberId) }, 100000, { paidAt: '2026-01-02T00:00:00Z' });
  for (const status of ['pending', 'failed', 'cancelled']) await models.Payment.create({ gymId: gymA._id, memberId: memberA._id,
    subscriptionId: sub._id, amountPaise: 50000, paymentMethod: 'cash', paidAt: new Date('2026-03-01T00:00:00Z'), status });
  const data = await dashboard(token, '?from=2026-03-01');
  assert.equal(data.payments.periodSuccessfulAmountPaise, 0);
  assert.equal(data.payments.outstandingAmountPaise, 50000);
});
test('outstanding dues respect gym isolation despite historical branch IDs', async () => {
  const token = await login();
  await period('2020-01-01', 30);
  await period('2020-01-01', 30, { memberId: memberOther._id });
  await period('2020-01-01', 30, { gymId: gymB._id, memberId: memberB._id, membershipPlanId: planB._id });
  await models.MemberProfile.updateOne({ _id: memberOther._id }, { branchId: branchOther._id });
  assert.equal((await dashboard(token)).payments.outstandingAmountPaise, 300000);
});
test('payments with foreign gym or wrong member cannot reduce another subscription balance', async () => {
  const token = await login(); const sub = await period('2020-01-01', 30);
  for (const values of [{ gymId: gymB._id, memberId: memberA._id }, { gymId: gymA._id, memberId: memberOther._id }]) {
    await models.Payment.create({ ...values, subscriptionId: sub._id, amountPaise: 50000,
      paymentMethod: 'cash', paidAt: new Date('2020-01-02T00:00:00Z') });
  }
  assert.equal((await dashboard(token)).payments.outstandingAmountPaise, 150000);
});
for (const badPrice of [-1, 1.5, 1000000001, 'invalid']) test(`invalid subscription price ${badPrice} fails closed for dues`, async () => {
  const sub = await period('2020-01-01', 30);
  await models.MemberSubscription.collection.updateOne({ _id: sub._id }, { $set: { pricePaiseSnapshot: badPrice } });
  error(await send('get', dashboardPath(), await login()), 500, 'INTERNAL_SERVER_ERROR');
});
test('invalid historical payment outside revenue period still fails dues closed', async () => {
  const sub = await period('2020-01-01', 30);
  const paid = await models.Payment.create({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub._id,
    amountPaise: 100, paymentMethod: 'cash', paidAt: new Date('2020-01-02T00:00:00Z') });
  await models.Payment.collection.updateOne({ _id: paid._id }, { $set: { amountPaise: 1.5 } });
  error(await send('get', dashboardPath(), await login()), 500, 'INTERNAL_SERVER_ERROR');
});
test('overpayment on one subscription cannot offset another unpaid balance', async () => {
  const sub = await period('2020-01-01', 30); await period('2020-01-01', 30, { memberId: memberOther._id });
  await models.Payment.create({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub._id,
    amountPaise: 150001, paymentMethod: 'cash', paidAt: new Date('2020-01-02T00:00:00Z') });
  error(await send('get', dashboardPath(), await login()), 500, 'INTERNAL_SERVER_ERROR');
});

test('unsafe outstanding totals fail checked integer conversion', async () => {
  const token = await login(); const original = models.MemberSubscription.aggregate;
  models.MemberSubscription.aggregate = function (pipeline) {
    if (pipeline.some((stage) => stage.$lookup?.from === models.Payment.collection.name)) {
      return Promise.resolve([{ amount: mongoose.Types.Decimal128.fromString('9007199254740992'), invalid: 0 }]);
    }
    return original.call(this, pipeline);
  };
  try { error(await send('get', dashboardPath(), token), 500, 'INTERNAL_SERVER_ERROR'); }
  finally { models.MemberSubscription.aggregate = original; }
});

// Quick periods are resolved by the same gym-local calendar as default today.
for (const example of [
  { zone: 'Asia/Kolkata', now: '2026-10-11T20:00:00Z', preset: 'last7Days', from: '2026-10-06', to: '2026-10-12', start: '2026-10-05T18:30:00.000Z', end: '2026-10-12T18:30:00.000Z' },
  { zone: 'UTC', now: '2026-01-03T12:00:00Z', preset: 'last7Days', from: '2025-12-28', to: '2026-01-03', start: '2025-12-28T00:00:00.000Z', end: '2026-01-04T00:00:00.000Z' },
  { zone: 'America/New_York', now: '2026-03-09T01:00:00Z', preset: 'last7Days', from: '2026-03-02', to: '2026-03-08', start: '2026-03-02T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' },
  { zone: 'Asia/Kolkata', now: '2024-02-28T20:00:00Z', preset: 'thisMonth', from: '2024-02-01', to: '2024-02-29', start: '2024-01-31T18:30:00.000Z', end: '2024-02-29T18:30:00.000Z' },
  { zone: 'America/New_York', now: '2026-03-15T12:00:00Z', preset: 'thisMonth', from: '2026-03-01', to: '2026-03-31', start: '2026-03-01T05:00:00.000Z', end: '2026-04-01T04:00:00.000Z' },
]) test(`quick ${example.preset}: ${example.zone} ${example.from}`, async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': example.zone });
  const data = await fixed(example.now, { preset: example.preset });
  assert.deepEqual(data.period, { timezone: example.zone, from: example.from, to: example.to,
    startUtc: example.start, endUtc: example.end,  });
});

test('quick presets retain gym/role authorization and reject retired branch filters', async () => {
  const token = await login();
  for (const preset of ['last7Days', 'thisMonth']) {
    await dashboard(token, '?preset=' + preset);
    error(await send('get', dashboardPath(gymB) + '?preset=' + preset, token), 403, 'FORBIDDEN');
    error(await send('get', dashboardPath() + '?preset=' + preset + '&branchId=' + branchB._id, token), 400, 'VALIDATION_ERROR');
    error(await send('get', dashboardPath() + '?preset=' + preset, await login(trainer)), 403, 'FORBIDDEN');
  }
});
test('unknown presets and presets combined with explicit dates rejected', async () => {
  const token = await login();
  for (const query of ['?preset=allTime', '?preset=last7Days&from=2026-10-10', '?preset=thisMonth&to=2026-10-12', '?preset=a&preset=b']) {
    error(await send('get', dashboardPath() + query, token), 400, 'VALIDATION_ERROR');
  }
});
test('today zero and historical two-payment revenue leave the same outstanding balance', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  const sub = await period('2026-10-01', 30, { pricePaiseSnapshot: 350000 });
  for (const at of ['2026-10-09T18:30:00.000Z', '2026-10-10T18:29:59.999Z']) {
    await models.Payment.create({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub._id,
      amountPaise: 150000, paymentMethod: 'cash', paidAt: new Date(at), status: 'succeeded' });
  }
  for (const [query, expectedRevenue, expectedCount] of [
    [{}, 0, 0], [{ from: '2026-10-10', to: '2026-10-10' }, 300000, 2],
    [{ preset: 'last7Days' }, 300000, 2], [{ preset: 'thisMonth' }, 300000, 2],
  ]) {
    const data = await fixed('2026-10-12T12:00:00Z', query);
    assert.deepEqual(data.payments, { periodSuccessfulAmountPaise: expectedRevenue, periodSuccessfulCount: expectedCount, outstandingAmountPaise: 50000 });
  }
});
