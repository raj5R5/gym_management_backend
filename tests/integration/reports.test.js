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
async function period(profile, startOffset, days, price = 150000) {
  return models.MemberSubscription.create({ gymId: profile.gymId, memberId: profile._id, membershipPlanId: plan._id,
    startDate: utcDay(startOffset), endDate: utcDay(startOffset + days), durationDaysSnapshot: days,
    pricePaiseSnapshot: price, planNameSnapshot: plan.name, status: 'active' });
}
async function pay(sub, amountPaise) {
  return models.Payment.create({ gymId: sub.gymId, memberId: sub.memberId, subscriptionId: sub._id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date(), status: 'succeeded', recordedByUserId: admin._id });
}

const visitAt = (profile, offset, hour = 7) => models.MemberVisit.create({ gymId: profile.gymId, memberId: profile._id,
  visitDate: utcDay(offset), checkedInAt: new Date(utcDay(offset).getTime() + hour * 3600_000), method: 'manual',
  membershipState: 'active', recordedByUserId: admin._id });
const report = (kind, token, query = '', gym = gymA) =>
  send('get', `/api/v1/gyms/${gym._id}/reports/${kind}?from=${iso(-20)}&to=${iso(0)}${query}`, token);

async function seed() {
  // Riya: joined, paid ₹1,000 of ₹1,500; Other: an older plan that expired and was renewed.
  const sub = await period(riya, -5, 30);
  await pay(sub, 100000);
  const old = await period(other, -40, 30); // ended at -10: expired in the period
  await pay(old, 150000);
  await period(other, -9, 30, 120000); // renewal
  await models.PtPayment.create({ gymId: gymA._id, packageId: trainerA._id, memberId: riya._id, trainerId: trainerA._id,
    amountPaise: 40000, paymentMethod: 'upi', reference: 'UTR1', paidAt: new Date(), commissionPercent: 10,
    commissionPaise: 4000, recordedByUserId: admin._id });
  await models.Expense.create({ gymId: gymA._id, category: 'rent', amountPaise: 30000, spentOn: utcDay(-2),
    paymentMethod: 'cash', recordedByUserId: admin._id });
  await visitAt(riya, 0, 6); await visitAt(riya, -1, 6); await visitAt(other, 0, 18);
}

test('profit & loss, collections and plans add up for one branch', async () => {
  await seed();
  const token = await login();
  let response = await report('profit-loss', token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const pl = response.body.data.report.totals;
  // Membership paid today: ₹1,000 (Riya) + ₹1,500 (Other's older plan).
  assert.deepEqual([pl.membershipPaise, pl.ptPaise, pl.expensesPaise, pl.commissionPaise], [250000, 40000, 30000, 4000]);
  assert.equal(pl.profitPaise, 250000 + 40000 - 30000 - 4000);
  assert.deepEqual(response.body.data.report.expensesByCategory, [{ key: 'rent', amountPaise: 30000 }]);

  response = await report('collections', token);
  const collections = response.body.data.report;
  assert.equal(collections.totals.amountPaise, 290000);
  assert.deepEqual(collections.byMethod.map((row) => [row.key, row.amountPaise]), [['cash', 250000], ['upi', 40000]]);
  assert.deepEqual(collections.byPlan.map((row) => row.key).sort(), ['Monthly', 'Personal training']);

  response = await report('plans', token);
  const plans = response.body.data.report;
  // Sold in the period: Riya's (−5) and Other's renewal (−9); both active now.
  assert.deepEqual([plans.totals.sold, plans.totals.revenuePaise, plans.totals.activeMembers], [2, 270000, 2]);
});
test('members, attendance, dues, leads and trainers', async () => {
  await seed();
  await models.Lead.create({ gymId: gymA._id, firstName: 'A', phone: '9000000001', phoneDigits: '9000000001', source: 'instagram',
    status: 'joined', createdByUserId: admin._id });
  await models.Lead.create({ gymId: gymA._id, firstName: 'B', phone: '9000000002', phoneDigits: '9000000002', source: 'instagram',
    status: 'lost', lostReason: 'Too far', createdByUserId: admin._id });
  const token = await login();
  const members = (await report('members', token)).body.data.report;
  assert.deepEqual([members.started, members.firstTime, members.renewals, members.expired, members.renewed, members.churned],
    [2, 1, 1, 1, 1, 0]);
  assert.equal(members.renewalRatePercent, 100);
  assert.equal(members.activeAtMonthEnd.at(-1).count, 2);

  const attendance = (await report('attendance', token)).body.data.report;
  assert.deepEqual([attendance.visits, attendance.uniqueMembers, attendance.stoppedComingCount], [3, 2, 0]);
  assert.equal(attendance.byHour[6].count, 2); assert.equal(attendance.byHour[18].count, 1);
  assert.equal(attendance.averagePerDay, Math.round((3 / 21) * 10) / 10);

  const dues = (await report('dues', token)).body.data.report;
  assert.deepEqual([dues.membershipDuesPaise, dues.membersOwing], [50000 + 120000, 2]);
  assert.equal(dues.topDebtors[0].amountPaise, 120000);

  const leads = (await report('leads', token)).body.data.report;
  assert.deepEqual([leads.created, leads.joined, leads.lost, leads.conversionPercent], [2, 1, 1, 50]);
  assert.deepEqual(leads.lostReasons, [{ key: 'too far', count: 1 }]);

  const trainers = (await report('trainers', token)).body.data.report;
  assert.deepEqual([trainers.trainers[0].name, trainers.trainers[0].ptCollectedPaise, trainers.trainers[0].commissionPaise],
    ['Vikram Rao', 40000, 4000]);
});
test('all branches adds the owner\'s gyms; access and ranges are checked', async () => {
  await seed();
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const b = await models.MemberProfile.create({ gymId: gymB._id, memberCode: 'B1', firstName: 'Bina', lastName: 'K', phone: '9876543210' });
  const planB = await models.MembershipPlan.create({ gymId: gymB._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 50000 });
  const subB = await models.MemberSubscription.create({ gymId: gymB._id, memberId: b._id, membershipPlanId: planB._id,
    startDate: utcDay(-1), endDate: utcDay(29), durationDaysSnapshot: 30, pricePaiseSnapshot: 50000, planNameSnapshot: 'Monthly', status: 'active' });
  await pay(subB, 50000);
  const token = await login();
  const one = (await report('collections', token)).body.data;
  const all = (await report('collections', token, '&scope=all')).body.data;
  assert.equal(all.branches.length, 2);
  assert.equal(all.report.totals.amountPaise, one.report.totals.amountPaise + 50000);
  assert.equal(all.report.byPlan.find((row) => row.key === 'Monthly').amountPaise, 300000);
  const dues = (await report('dues', token, '&scope=all')).body.data.report;
  assert.deepEqual([...new Set(dues.topDebtors.map((row) => row.branch))], ['Gym A']);

  // Presets and limits.
  let response = await send('get', `/api/v1/gyms/${gymA._id}/reports/collections?preset=lastMonth`, token);
  assert.equal(response.status, 200);
  assert.ok(response.body.data.period.to < iso(0).slice(0, 7) + '-01');
  response = await send('get', `/api/v1/gyms/${gymA._id}/reports/collections?from=${iso(-400)}&to=${iso(0)}`, token);
  assert.equal(response.body.error.code, 'REPORT_RANGE_TOO_LONG');
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/reports/collections?from=${iso(-1)}`, token)).status, 400);
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/reports/unknown`, token)).status, 400);
  assert.equal((await report('collections', await login(trainer))).status, 403);
  assert.equal((await report('collections', await login(memberUser))).status, 403);
  await models.GymAccess.deleteOne({ userId: admin._id, gymId: gymB._id });
  assert.equal((await report('collections', token, '', gymB)).status, 403);
});
