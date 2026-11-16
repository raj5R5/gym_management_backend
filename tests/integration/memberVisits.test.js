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

// ---- Check-in ----
const visitsPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/visits`;
async function checkIn(token, body, gym = gymA) { return send('post', visitsPath(gym), token, body); }

test('active member checks in once per day; repeats return the same visit', async () => {
  const token = await login();
  const aarav = await member('Aarav'); await period(aarav, -5, 30);
  let response = await checkIn(token, { memberId: String(aarav._id), method: 'qr' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const first = response.body.data;
  assert.equal(first.alreadyCheckedIn, false);
  assert.equal(first.visit.method, 'qr');
  assert.equal(first.visit.membershipState, 'active');
  assert.equal(first.visit.override, false);
  assert.equal(first.visit.visitDate, utcDay().toISOString().slice(0, 10));
  assert.equal(first.member.firstName, 'Aarav');
  assert.equal(first.membership.daysLeft, 25);
  response = await checkIn(token, { memberId: String(aarav._id) });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.alreadyCheckedIn, true);
  assert.equal(response.body.data.visit.id, first.visit.id);
  assert.equal(await models.MemberVisit.countDocuments(), 1);
});
test('concurrent check-ins for one member record a single visit', async () => {
  const token = await login();
  const aarav = await member('Aarav'); await period(aarav, -5, 30);
  const responses = await Promise.all([1, 2, 3, 4].map(() => checkIn(token, { memberId: String(aarav._id) })));
  assert.ok(responses.every((response) => [200, 201].includes(response.status)));
  assert.equal(new Set(responses.map((response) => response.body.data.visit.id)).size, 1);
  assert.equal(await models.MemberVisit.countDocuments(), 1);
});
test('expired or plan-less members need an explicit override, which is recorded', async () => {
  const token = await login();
  const sneha = await member('Sneha'); await period(sneha, -40, 30);
  const pooja = await member('Pooja');
  let response = await checkIn(token, { memberId: String(sneha._id) });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'MEMBERSHIP_NOT_ACTIVE');
  assert.equal(response.body.error.details.membershipState, 'expired');
  assert.equal(response.body.error.details.planName, 'Monthly');
  response = await checkIn(token, { memberId: String(pooja._id) });
  assert.equal(response.body.error.details.membershipState, 'none');
  assert.equal(await models.MemberVisit.countDocuments(), 0);
  response = await checkIn(token, { memberId: String(sneha._id), override: true });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.visit.override, true);
  assert.equal(response.body.data.visit.membershipState, 'expired');
});
test('upcoming memberships also need an override', async () => {
  const token = await login();
  const future = await member('Future'); await period(future, 3, 30);
  const response = await checkIn(token, { memberId: String(future._id) });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.details.membershipState, 'upcoming');
});
test('check-in validates input and enforces role, gym and member status', async () => {
  const token = await login();
  const aarav = await member('Aarav'); await period(aarav, -5, 30);
  const other = await member('Other', gymB);
  for (const body of [{}, { memberId: 'x' }, { memberId: String(aarav._id), method: 'face' },
    { memberId: String(aarav._id), gymId: String(gymA._id) }, { memberId: String(aarav._id), override: 'yes' }]) {
    assert.equal((await checkIn(token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await checkIn(token, { memberId: String(other._id) })).status, 404, 'other gym member');
  assert.equal((await checkIn(token, { memberId: String(aarav._id) }, gymB)).status, 403);
  assert.equal((await checkIn(await login(trainer), { memberId: String(aarav._id) })).status, 403);
  assert.equal((await send('post', visitsPath(), undefined, { memberId: String(aarav._id) })).status, 401);
  await models.MemberProfile.updateOne({ _id: aarav._id }, { status: 'suspended' });
  const response = await checkIn(token, { memberId: String(aarav._id) });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'MEMBER_NOT_ACTIVE');
  assert.equal(await models.MemberVisit.countDocuments(), 0);
});
test('today lists visits newest first with override count, scoped to the gym day', async () => {
  const token = await login();
  const a = await member('Aarav'); await period(a, -5, 30);
  const s = await member('Sneha'); await period(s, -40, 30);
  await checkIn(token, { memberId: String(a._id) });
  await checkIn(token, { memberId: String(s._id), override: true });
  await models.MemberVisit.create({ gymId: gymA._id, memberId: a._id, recordedByUserId: admin._id,
    visitDate: utcDay(-1), checkedInAt: new Date(Date.now() - 86_400_000), method: 'manual', membershipState: 'active' });
  const response = await send('get', `${visitsPath()}/today`, token);
  assert.equal(response.status, 200);
  const data = response.body.data;
  assert.equal(data.total, 2);
  assert.equal(data.overrides, 1);
  assert.equal(data.timezone, 'UTC');
  assert.deepEqual(data.data.map((row) => row.member.firstName), ['Sneha', 'Aarav']);
  assert.equal((await send('get', `${visitsPath()}/today`, await login(trainer))).status, 403);
});
test('member history pages visits and reports the last visit and 30-day count', async () => {
  const token = await login();
  const a = await member('Aarav'); await period(a, -60, 90);
  for (const offset of [-45, -20, -3]) {
    await models.MemberVisit.create({ gymId: gymA._id, memberId: a._id, recordedByUserId: admin._id,
      visitDate: utcDay(offset), checkedInAt: new Date(utcDay(offset).getTime() + 3_600_000), method: 'manual', membershipState: 'active' });
  }
  const response = await send('get', `/api/v1/gyms/${gymA._id}/members/${a._id}/visits?limit=2`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const data = response.body.data;
  assert.equal(data.visitsLast30Days, 2);
  assert.equal(data.daysSinceLastVisit, 3);
  assert.equal(data.lastVisitDate, utcDay(-3).toISOString().slice(0, 10));
  assert.equal(data.data.length, 2);
  assert.deepEqual(data.pagination, { page: 1, limit: 2, total: 3 });
  const other = await member('Other', gymB);
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/members/${other._id}/visits`, token)).status, 404);
});
test('overview flags active members who have not visited in 10+ days', async () => {
  const token = await login();
  const regular = await member('Regular'); await period(regular, -20, 60);
  const absent = await member('Absent'); await period(absent, -20, 60);
  const never = await member('Never'); await period(never, -20, 60);
  const lapsed = await member('Lapsed'); await period(lapsed, -40, 30);
  for (const [profile, offset] of [[regular, -2], [absent, -12], [lapsed, -15]]) {
    await models.MemberVisit.create({ gymId: gymA._id, memberId: profile._id, recordedByUserId: admin._id,
      visitDate: utcDay(offset), checkedInAt: utcDay(offset), method: 'manual', membershipState: 'active' });
  }
  const response = await send('get', `/api/v1/gyms/${gymA._id}/member-overview?filter=inactive`, token);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.counts.inactive, 2);
  assert.deepEqual(response.body.data.data.map((row) => row.member.firstName), ['Never', 'Absent']);
  assert.equal(response.body.data.data[1].daysSinceLastVisit, 12);
  assert.equal(response.body.data.data[0].lastVisitDate, null);
});
test('dashboard reports visits in the period and today', async () => {
  const token = await login();
  const a = await member('Aarav'); await period(a, -5, 30);
  const b = await member('Bina'); await period(b, -5, 30);
  await checkIn(token, { memberId: String(a._id) });
  await checkIn(token, { memberId: String(b._id) });
  await models.MemberVisit.create({ gymId: gymA._id, memberId: a._id, recordedByUserId: admin._id,
    visitDate: utcDay(-3), checkedInAt: utcDay(-3), method: 'manual', membershipState: 'active' });
  const response = await send('get', `/api/v1/gyms/${gymA._id}/dashboard?preset=last7Days`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.visits, { periodCount: 3, distinctMembers: 2, today: 2 });
});
test('visits are append-only', async () => {
  const token = await login();
  const a = await member('Aarav'); await period(a, -5, 30);
  const { body } = await checkIn(token, { memberId: String(a._id) });
  await assert.rejects(models.MemberVisit.updateOne({ _id: body.data.visit.id }, { method: 'qr' }));
});
