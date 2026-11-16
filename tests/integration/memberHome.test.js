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

let isolated, database, config, models, app, gymA, gymB, admin, trainer, passwordHash, memberUser, riya, other, plan, trainerA;
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
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active',
    settings: { timezone: 'UTC', upiId: 'gyma@okaxis', upiPayeeName: 'Gym A' } });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  admin = await models.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
  trainer = await models.UserAccount.create({ email: 'trainer@example.com', passwordHash, status: 'active' });
  memberUser = await models.UserAccount.create({ email: 'riya@example.com', passwordHash, status: 'active' });
  await models.GymAccess.create({ userId: admin._id, gymId: gymA._id, role: 'admin', status: 'active' });
  await models.GymAccess.create({ userId: trainer._id, gymId: gymA._id, role: 'trainer', status: 'active' });
  await models.GymAccess.create({ userId: memberUser._id, gymId: gymA._id, role: 'member', status: 'active' });
  riya = await member('Riya'); await models.MemberProfile.updateOne({ _id: riya._id }, { $set: { userId: memberUser._id } }, { overwriteImmutable: true });
  other = await member('Other');
  plan = await models.MembershipPlan.create({ gymId: gymA._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 150000 });
  trainerA = await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR01', firstName: 'Vikram', lastName: 'Rao', phone: '9876543210' });
});

const iso = (offset) => utcDay(offset).toISOString().slice(0, 10);
const me = (path, gym = gymA) => `/api/v1/me/gyms/${gym._id}${path}`;
async function period(profile, startOffset, days, price = 150000) {
  return models.MemberSubscription.create({ gymId: profile.gymId, memberId: profile._id, membershipPlanId: plan._id,
    startDate: utcDay(startOffset), endDate: utcDay(startOffset + days), durationDaysSnapshot: days,
    pricePaiseSnapshot: price, planNameSnapshot: plan.name, status: 'active' });
}
async function pay(sub, amountPaise) {
  return models.Payment.create({ gymId: sub.gymId, memberId: sub.memberId, subscriptionId: sub._id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date(), status: 'succeeded', recordedByUserId: admin._id });
}
const visit = (profile, offset) => models.MemberVisit.create({ gymId: profile.gymId, memberId: profile._id,
  visitDate: utcDay(offset), checkedInAt: new Date(), method: 'manual', membershipState: 'active', recordedByUserId: admin._id });

test('home shows membership, dues, gym UPI, visits and PT without commission', async () => {
  const sub = await period(riya, -10, 30);
  await pay(sub, 50000);
  await models.PtPackage.create({ gymId: gymA._id, memberId: riya._id, trainerId: trainerA._id, name: 'PT 12', sessionsTotal: 12,
    sessionsUsed: 3, pricePaise: 600000, paidPaise: 100000, startDate: utcDay(-5), commissionPercent: 20, createdByUserId: admin._id });
  await visit(riya, 0); await visit(riya, -7); await visit(riya, -14);
  await visit(other, 0);
  const response = await send('get', me('/home'), await login(memberUser));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const home = response.body.data;
  assert.equal(home.member.memberCode, riya.memberCode);
  assert.equal(home.gym.upiId, 'gyma@okaxis');
  assert.equal(home.membership.state, 'active'); assert.equal(home.membership.daysLeft, 20);
  assert.equal(home.membership.endDate, iso(20)); assert.equal(home.membership.frozenUntil, null);
  assert.deepEqual(home.dues, { balancePaise: 100000, dueSubscriptionId: String(sub._id), pendingClaimPaise: 0 });
  assert.equal(home.visits.visitedToday, true); assert.equal(home.visits.weekStreak, 3);
  assert.deepEqual(home.visits.recent, [iso(0), iso(-7), iso(-14)]);
  assert.equal(home.pt.length, 1);
  assert.deepEqual([home.pt[0].trainerName, home.pt[0].sessionsLeft, home.pt[0].balancePaise], ['Vikram Rao', 9, 500000]);
  assert.equal(JSON.stringify(home).includes('commission'), false);
});
test('a member reads only their own receipts; staff and other gyms are refused', async () => {
  const mine = await pay(await period(riya, -1, 30), 150000);
  const theirs = await pay(await period(other, -1, 30), 150000);
  const token = await login(memberUser);
  const response = await send('get', me(`/payments/${mine._id}/receipt`), token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.receiptNumber, 'R-00001');
  assert.equal(response.body.data.member.memberCode, riya.memberCode);
  assert.equal((await send('get', me(`/payments/${theirs._id}/receipt`), token)).body.error.code, 'PAYMENT_NOT_FOUND');
  assert.equal((await send('get', me('/home', gymB), token)).status, 403);
  assert.equal((await send('get', me('/home'), await login(admin))).status, 403);
  assert.equal((await send('get', me('/home'), await login(trainer))).status, 403);
  assert.equal((await send('get', me('/home?memberId=x'), token)).status, 400);
  await models.GymAccess.updateOne({ userId: memberUser._id }, { status: 'suspended' });
  assert.equal((await send('get', me('/home'), token)).status, 403);
});
test('no membership yet: home still loads with empty sections', async () => {
  const home = (await send('get', me('/home'), await login(memberUser))).body.data;
  assert.equal(home.membership, null);
  assert.deepEqual(home.dues, { balancePaise: 0, dueSubscriptionId: null, pendingClaimPaise: 0 });
  assert.deepEqual(home.visits, { thisMonth: 0, lastVisitDate: null, visitedToday: false, weekStreak: 0, recent: [] });
  assert.deepEqual(home.pt, []);
});
