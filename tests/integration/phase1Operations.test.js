const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { classify } = require('../../src/modules/memberOverview/overview.service');

let isolated, database, config, models, app, gymA, gymB, admin, trainer, plan, passwordHash;
const password = randomBytes(24).toString('base64url');
const utcDay = (offset = 0) => { const value = new Date(); value.setUTCHours(0, 0, 0, 0); value.setUTCDate(value.getUTCDate() + offset); return value; };

function send(method, url, token, body) {
  const pending = request(app)[method](url);
  if (token) pending.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) pending.send(body);
  return pending;
}
async function login(account = admin) {
  const response = await request(app).post('/api/v1/auth/login').send({ email: account.email, password, client: 'mobile' });
  assert.equal(response.status, 200); return response.body.data.accessToken;
}
let codes = 0;
async function member(firstName, gym = gymA) {
  codes += 1;
  return models.MemberProfile.create({ gymId: gym._id, memberCode: `ME${String(codes).padStart(3, '0')}`, firstName, lastName: 'Test', phone: '9876543210' });
}
async function period(profile, startOffset, days, { price = 150000, status = 'active', planRecord = plan } = {}) {
  return models.MemberSubscription.create({ gymId: profile.gymId, memberId: profile._id, membershipPlanId: planRecord._id,
    startDate: utcDay(startOffset), endDate: utcDay(startOffset + days), durationDaysSnapshot: days,
    pricePaiseSnapshot: price, planNameSnapshot: planRecord.name, status });
}
async function pay(sub, amountPaise, status = 'succeeded') {
  return models.Payment.create({ gymId: sub.gymId, memberId: sub.memberId, subscriptionId: sub._id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date(), status, recordedByUserId: admin._id });
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
  try { if (database) await database.disconnect(); } finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
  app = createApp({ config, database });
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active', settings: { timezone: 'UTC' } });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  admin = await models.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
  trainer = await models.UserAccount.create({ email: 'trainer@example.com', passwordHash, status: 'active' });
  await models.GymAccess.create({ userId: admin._id, gymId: gymA._id, role: 'admin', status: 'active' });
  await models.GymAccess.create({ userId: trainer._id, gymId: gymA._id, role: 'trainer', status: 'active' });
  plan = await models.MembershipPlan.create({ gymId: gymA._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 150000 });
});

// ---- Gym settings ----
const settingsPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/settings`;
test('admin reads and updates gym settings; nulls clear optional fields', async () => {
  const token = await login();
  let response = await send('get', settingsPath(), token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { gymId: String(gymA._id), timezone: 'UTC', timezoneConfigured: true, gstin: null, address: null,
    upiId: null, upiPayeeName: null });
  assert.equal(response.headers['cache-control'], 'no-store');
  response = await send('patch', settingsPath(), token, { timezone: 'Asia/Kolkata', gstin: '27aapfu0939f1zv',
    address: { line1: '12 MG Road', city: 'Pune', postalCode: '411001' } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.timezone, 'Asia/Kolkata');
  assert.equal(response.body.data.gstin, '27AAPFU0939F1ZV');
  assert.deepEqual(response.body.data.address, { line1: '12 MG Road', city: 'Pune', postalCode: '411001' });
  response = await send('patch', settingsPath(), token, { gstin: null });
  assert.equal(response.body.data.gstin, null);
  assert.equal(response.body.data.timezone, 'Asia/Kolkata', 'omitted fields are unchanged');
  assert.deepEqual(response.body.data.address, { line1: '12 MG Road', city: 'Pune', postalCode: '411001' });
});
test('gym settings reject invalid input and unknown fields', async () => {
  const token = await login();
  for (const body of [{}, { timezone: 'Mars/Base' }, { timezone: null }, { gstin: '1234' }, { address: { city: 'Pune' } },
    { name: 'Renamed' }, { settings: { timezone: 'UTC' } }]) {
    const response = await send('patch', settingsPath(), token, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await models.Gym.findById(gymA._id).lean()).settings.timezone, 'UTC');
});
test('gym settings are admin-only and gym-scoped', async () => {
  assert.equal((await send('get', settingsPath(), await login(trainer))).status, 403);
  assert.equal((await send('patch', settingsPath(), await login(trainer), { timezone: 'Asia/Kolkata' })).status, 403);
  assert.equal((await send('get', settingsPath(gymB), await login())).status, 403);
  assert.equal((await send('get', settingsPath())).status, 401);
});
test('unconfigured timezone is reported as not configured', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { $unset: { settings: '' } });
  const response = await send('get', settingsPath(), await login());
  assert.equal(response.body.data.timezone, null);
  assert.equal(response.body.data.timezoneConfigured, false);
});

// ---- Member overview ----
const overviewPath = (query = '', gym = gymA) => `/api/v1/gyms/${gym._id}/member-overview${query}`;
async function overview(query = '') {
  const response = await send('get', overviewPath(query), await login());
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
}
async function scenario() {
  const expiring = await member('Aarav'); const s1 = await period(expiring, -27, 30); await pay(s1, 150000);
  const partial = await member('Vikram'); const s2 = await period(partial, -10, 30); await pay(s2, 50000);
  const expired = await member('Sneha'); const s3 = await period(expired, -40, 30); await pay(s3, 150000);
  const renewed = await member('Isha'); const s4 = await period(renewed, -28, 30); await pay(s4, 150000);
  await period(renewed, 2, 30, { price: 0 });
  const none = await member('Pooja');
  const cancelled = await member('Karan'); await period(cancelled, -5, 30, { status: 'cancelled' });
  const other = await member('Other', gymB);
  return { expiring, partial, expired, renewed, none, cancelled, other };
}
test('overview classifies members, counts filters and totals dues', async () => {
  const people = await scenario();
  const data = await overview();
  assert.deepEqual(data.counts, { all: 6, active: 3, expiring: 1, dues: 1, expired: 1, none: 2, inactive: 3 });
  assert.equal(data.duesTotalPaise, 100000);
  assert.equal(data.calendar.timezone, 'UTC');
  assert.deepEqual(data.data.map((row) => row.member.firstName), ['Aarav', 'Isha', 'Karan', 'Pooja', 'Sneha', 'Vikram']);
  const row = (name) => data.data.find((item) => item.member.firstName === name);
  assert.equal(row('Aarav').membership.state, 'active');
  assert.equal(row('Aarav').membership.daysLeft, 3);
  assert.equal(row('Aarav').membership.expiringSoon, true);
  assert.equal(row('Isha').membership.expiringSoon, false, 'renewed ahead is not expiring');
  assert.equal(row('Isha').membership.renewedAhead, true);
  assert.equal(row('Sneha').membership.state, 'expired');
  assert.equal(row('Sneha').membership.daysSinceExpiry, 10);
  assert.equal(row('Vikram').balancePaise, 100000);
  assert.equal(row('Vikram').dueSubscriptionId, String((await models.MemberSubscription.findOne({ memberId: people.partial._id }))._id));
  assert.equal(row('Karan').membership, null, 'cancelled periods are ignored');
  assert.equal(row('Pooja').membership, null);
  assert.doesNotMatch(JSON.stringify(data), /Other|password|token|photoPublicId/);
});
test('overview filters, sorts, searches and paginates', async () => {
  await scenario();
  assert.deepEqual((await overview('?filter=expiring')).data.map((row) => row.member.firstName), ['Aarav']);
  assert.deepEqual((await overview('?filter=dues')).data.map((row) => row.member.firstName), ['Vikram']);
  assert.deepEqual((await overview('?filter=expired')).data.map((row) => row.member.firstName), ['Sneha']);
  assert.deepEqual((await overview('?filter=none')).data.map((row) => row.member.firstName), ['Karan', 'Pooja']);
  assert.deepEqual((await overview('?search=VIK')).data.map((row) => row.member.firstName), ['Vikram']);
  const paged = await overview('?limit=2&page=2');
  assert.deepEqual(paged.data.map((row) => row.member.firstName), ['Karan', 'Pooja']);
  assert.deepEqual(paged.pagination, { page: 2, limit: 2, total: 6 });
  assert.equal(paged.counts.all, 6, 'counts ignore pagination');
});
test('overview rejects bad queries and is admin-only and gym-scoped', async () => {
  for (const query of ['?filter=late', '?limit=500', '?gymId=x']) {
    assert.equal((await send('get', overviewPath(query), await login())).status, 400, query);
  }
  assert.equal((await send('get', overviewPath(), await login(trainer))).status, 403);
  assert.equal((await send('get', overviewPath('', gymB), await login())).status, 403);
  assert.equal((await send('get', overviewPath())).status, 401);
});
test('classify uses the earliest unpaid period and handles overpayment-free balances', () => {
  const today = utcDay();
  const a = { _id: 'a', membershipPlanId: 'p', planNameSnapshot: 'M', pricePaiseSnapshot: 1000, startDate: utcDay(-60), endDate: utcDay(-30) };
  const b = { _id: 'b', membershipPlanId: 'p', planNameSnapshot: 'M', pricePaiseSnapshot: 1000, startDate: utcDay(-30), endDate: utcDay(0) };
  const result = classify([b, a], new Map([['a', 400]]), today);
  assert.equal(result.balancePaise, 1600);
  assert.equal(result.dueSubscriptionId, 'a');
  assert.equal(result.membership.state, 'expired', 'end date is exclusive');
  assert.equal(result.membership.subscriptionId, 'b');
});

// ---- Plans and dashboard additions ----
test('plan list reports distinct currently active members per plan', async () => {
  await scenario();
  const yearly = await models.MembershipPlan.create({ gymId: gymA._id, name: 'Yearly', normalizedName: 'yearly', durationDays: 365, price: 1200000 });
  const response = await send('get', `/api/v1/gyms/${gymA._id}/membership-plans`, await login());
  assert.equal(response.status, 200);
  const counts = Object.fromEntries(response.body.data.map((item) => [item.name, item.activeMemberCount]));
  assert.deepEqual(counts, { Monthly: 3, Yearly: 0 });
  assert.ok(yearly);
});
test('dashboard reports members who joined in the selected period', async () => {
  await member('Fresh');
  const old = await member('Old');
  await models.MemberProfile.collection.updateOne({ _id: old._id }, { $set: { createdAt: utcDay(-60) } });
  const response = await send('get', `/api/v1/gyms/${gymA._id}/dashboard?preset=thisMonth`, await login());
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.members.joinedInPeriod, 1);
  assert.equal(response.body.data.members.total, 2);
});
