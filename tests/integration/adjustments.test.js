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

async function pay(sub, amountPaise) {
  return models.Payment.create({ gymId: sub.gymId, memberId: sub.memberId, subscriptionId: sub._id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date(), status: 'succeeded', recordedByUserId: admin._id });
}
const iso = (offset) => utcDay(offset).toISOString().slice(0, 10);
const base = (sub, gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions/${sub._id}/adjustments`;
async function quarterly(name = 'Rohan', start = -10) { const profile = await member(name); return period(profile, start, 90); }

// ---- Freeze ----
test('freezing pushes the end date, shows as frozen, and blocks plain check-in', async () => {
  const token = await login();
  const sub = await quarterly();
  let response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(0), days: 10, reason: 'Travel' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const data = response.body.data;
  assert.equal(data.endDate, iso(90), 'was day 80, now 90');
  assert.equal(data.frozenDays, 10);
  assert.equal(data.freeze.daysLeft, 20);
  assert.deepEqual(data.freezes.map((freeze) => [freeze.startDate, freeze.endDate, freeze.days, freeze.status]),
    [[iso(0), iso(10), 10, 'current']]);
  const stored = await models.MemberSubscription.findById(sub._id).lean();
  assert.equal(stored.endDate.toISOString().slice(0, 10), iso(90));
  response = await send('get', `/api/v1/gyms/${gymA._id}/member-overview`, token);
  const row = response.body.data.data[0];
  assert.equal(row.membership.frozenUntil, iso(10));
  assert.equal(row.membership.daysLeft, 90);
  assert.equal(response.body.data.counts.inactive, 0, 'frozen members are not chased');
  response = await send('post', `/api/v1/gyms/${gymA._id}/visits`, token, { memberId: String(sub.memberId) });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.details.membershipState, 'frozen');
  assert.equal(response.body.error.details.frozenUntil, iso(10));
  response = await send('post', `/api/v1/gyms/${gymA._id}/visits`, token, { memberId: String(sub.memberId), override: true });
  assert.equal(response.body.data.visit.membershipState, 'frozen');
  response = await send('get', `/api/v1/gyms/${gymA._id}/members/${sub.memberId}/summary`, token);
  assert.equal(response.status, 200, 'member summary accepts frozen end dates');
});
test('freeze rules: 90+ day plans, 30 days total, from today, no overlap, no queued renewal', async () => {
  const token = await login();
  const monthly = await period(await member('Monthly'), -5, 30);
  let response = await send('post', `${base(monthly)}/freezes`, token, { startDate: iso(0), days: 5 });
  assert.equal(response.status, 409); assert.equal(response.body.error.details.blocker, 'plan_too_short');
  const sub = await quarterly();
  response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(-1), days: 5 });
  assert.equal(response.body.error.details.blocker, 'start_out_of_range', 'no backdating');
  response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(80), days: 5 });
  assert.equal(response.body.error.details.blocker, 'start_out_of_range', 'must start before the end');
  assert.equal((await send('post', `${base(sub)}/freezes`, token, { startDate: iso(2), days: 20 })).status, 201);
  response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(30), days: 15 });
  assert.equal(response.body.error.details.blocker, 'too_many_days');
  assert.equal(response.body.error.details.daysLeft, 10);
  response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(10), days: 5 });
  assert.equal(response.body.error.code, 'FREEZE_OVERLAP');
  assert.equal((await send('post', `${base(sub)}/freezes`, token, { startDate: iso(40), days: 10 })).status, 201);
  response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(60), days: 1 });
  assert.equal(response.body.error.details.blocker, 'no_days_left');
  const queued = await quarterly('Queued');
  const stored = await models.MemberSubscription.findById(queued._id).lean();
  await models.MemberSubscription.create({ gymId: gymA._id, memberId: queued.memberId, membershipPlanId: plan._id,
    startDate: stored.endDate, endDate: new Date(stored.endDate.getTime() + 30 * 86_400_000), durationDaysSnapshot: 30,
    pricePaiseSnapshot: 150000, planNameSnapshot: 'Monthly' });
  response = await send('post', `${base(queued)}/freezes`, token, { startDate: iso(0), days: 5 });
  assert.equal(response.body.error.details.blocker, 'renewal_queued');
  for (const body of [{ startDate: iso(0), days: 0 }, { startDate: iso(0), days: 31 }, { startDate: iso(0) }, { days: 3 },
    { startDate: iso(0), days: 3, endDate: iso(3) }]) {
    assert.equal((await send('post', `${base(sub)}/freezes`, token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await models.MemberSubscription.findById(sub._id).lean()).frozenDays, 30);
});
test('ending a freeze early gives back unused days; future freezes return them all', async () => {
  const token = await login();
  const sub = await quarterly();
  let data = (await send('post', `${base(sub)}/freezes`, token, { startDate: iso(0), days: 10 })).body.data;
  let response = await send('post', `${base(sub)}/freezes/${data.freezes[0].id}/end`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  data = response.body.data;
  assert.equal(data.endDate, iso(80)); assert.equal(data.frozenDays, 0);
  assert.equal(data.freezes[0].endedEarly, true);
  assert.equal((await send('post', `${base(sub)}/freezes/${data.freezes[0].id}/end`, token)).body.error.details.blocker, 'freeze_finished');
  data = (await send('post', `${base(sub)}/freezes`, token, { startDate: iso(5), days: 7 })).body.data;
  const upcoming = data.freezes.find((freeze) => freeze.status === 'upcoming');
  data = (await send('post', `${base(sub)}/freezes/${upcoming.id}/end`, token)).body.data;
  assert.equal(data.frozenDays, 0); assert.equal(data.endDate, iso(80));
  await send('post', `${base(sub)}/freezes`, token, { startDate: iso(1), days: 5 });
  data = (await send('post', `${base(sub)}/freezes`, token, { startDate: iso(20), days: 5 })).body.data;
  const first = data.freezes.find((freeze) => freeze.startDate === iso(1));
  response = await send('post', `${base(sub)}/freezes/${first.id}/end`, token);
  assert.equal(response.body.error.details.blocker, 'later_freeze');
});

// ---- Discounts ----
test('discounts by amount or percent lower dues, never past the unpaid balance', async () => {
  const token = await login();
  const sub = await quarterly();
  await pay(sub, 100000);
  let response = await send('post', `${base(sub)}/discounts`, token, { percent: 10, reason: 'Festival offer' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  let data = response.body.data;
  assert.deepEqual({ list: data.listPricePaise, discount: data.discountPaise, price: data.pricePaise, balance: data.balancePaise },
    { list: 150000, discount: 15000, price: 135000, balance: 35000 });
  assert.equal(data.discounts[0].percent, 10);
  response = await send('post', `${base(sub)}/discounts`, token, { amountPaise: 40000 });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'DISCOUNT_EXCEEDS_BALANCE');
  assert.equal(response.body.error.details.balancePaise, 35000);
  data = (await send('post', `${base(sub)}/discounts`, token, { amountPaise: 35000 })).body.data;
  assert.equal(data.balancePaise, 0); assert.equal(data.discountPaise, 50000);
  response = await send('get', `/api/v1/gyms/${gymA._id}/member-overview?filter=dues`, token);
  assert.equal(response.body.data.counts.dues, 0, 'dues follow the discounted price');
  const payment = await models.Payment.findOne({ subscriptionId: sub._id }).lean();
  response = await send('get', `/api/v1/gyms/${gymA._id}/payments/${payment._id}/receipt`, token);
  assert.deepEqual({ list: response.body.data.membership.listPricePaise, discount: response.body.data.membership.discountPaise,
    balance: response.body.data.membership.balancePaise }, { list: 150000, discount: 50000, balance: 0 });
  for (const body of [{}, { amountPaise: 100, percent: 5 }, { amountPaise: 0 }, { percent: 101 }, { percent: 10.001 }]) {
    assert.equal((await send('post', `${base(sub)}/discounts`, token, body)).status, 400, JSON.stringify(body));
  }
});
test('concurrent discounts cannot together exceed the balance', async () => {
  const token = await login();
  const sub = await quarterly();
  const responses = await Promise.all([1, 2].map(() => send('post', `${base(sub)}/discounts`, token, { amountPaise: 100000 })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const stored = await models.MemberSubscription.findById(sub._id).lean();
  assert.equal(stored.pricePaiseSnapshot, 50000);
  assert.equal(await models.MembershipDiscount.countDocuments(), 1);
});
test('adjustments are admin-only, gym-scoped and not for cancelled memberships', async () => {
  const token = await login();
  const sub = await quarterly();
  assert.equal((await send('get', base(sub), await login(trainer))).status, 403);
  assert.equal((await send('get', base(sub, gymB), token)).status, 403);
  const other = await period(await member('Other', gymB), -10, 90);
  assert.equal((await send('get', base(other), token)).status, 404);
  await models.MemberSubscription.updateOne({ _id: sub._id }, { status: 'cancelled' });
  assert.equal((await send('post', `${base(sub)}/discounts`, token, { amountPaise: 100 })).body.error.code, 'SUBSCRIPTION_CANCELLED');
  assert.equal((await send('post', `${base(sub)}/freezes`, token, { startDate: iso(0), days: 3 })).body.error.details.blocker, 'cancelled');
  const response = await send('get', base(sub), token);
  assert.equal(response.status, 200); assert.equal(response.body.data.freeze.allowed, false);
});

test('memberships stored before Phase 3b (no counters) can be frozen and discounted', async () => {
  const token = await login();
  const profile = await member('Legacy');
  const start = utcDay(-10);
  const { insertedId } = await models.MemberSubscription.collection.insertOne({ gymId: gymA._id, memberId: profile._id,
    membershipPlanId: plan._id, startDate: start, endDate: new Date(start.getTime() + 90 * 86_400_000), status: 'active',
    durationDaysSnapshot: 90, pricePaiseSnapshot: 400000, planNameSnapshot: 'Quarterly', createdAt: new Date(), updatedAt: new Date() });
  const sub = { _id: insertedId };
  let response = await send('post', `${base(sub)}/freezes`, token, { startDate: iso(0), days: 7 });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.frozenDays, 7);
  response = await send('post', `${base(sub)}/discounts`, token, { amountPaise: 50000 });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.pricePaise, 350000);
});
