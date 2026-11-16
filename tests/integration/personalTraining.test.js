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

let isolated, database, config, models, app, gymA, gymB, admin, trainer, passwordHash, trainerA, trainerB, riya;
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
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active', settings: { timezone: 'UTC' } });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  admin = await models.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
  trainer = await models.UserAccount.create({ email: 'trainer@example.com', passwordHash, status: 'active' });
  await models.GymAccess.create({ userId: admin._id, gymId: gymA._id, role: 'admin', status: 'active' });
  await models.GymAccess.create({ userId: trainer._id, gymId: gymA._id, role: 'trainer', status: 'active' });
  trainerA = await models.TrainerProfile.create({ gymId: gymA._id, userId: trainer._id, trainerCode: 'TR01',
    firstName: 'Vikram', lastName: 'Rao', phone: '9876543210' });
  trainerB = await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', firstName: 'Neha', lastName: 'Iyer',
    phone: '9876543211' });
  riya = await member('Riya');
});

const iso = (offset) => utcDay(offset).toISOString().slice(0, 10);
const pt = (gym = gymA) => `/api/v1/gyms/${gym._id}/pt`;
async function sell(token, body = {}) {
  const response = await send('post', `${pt()}/packages`, token,
    { memberId: String(riya._id), trainerId: String(trainerA._id), sessions: 3, pricePaise: 600000, ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

test('selling a package snapshots the commission rate, links the trainer and takes a first payment', async () => {
  const token = await login();
  let response = await send('put', `${pt()}/rates/${trainerA._id}`, token, { percent: 12.5 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const pkg = await sell(token, { name: '12 sessions', validDays: 30, payment: { amountPaise: 200001, method: 'cash' } });
  assert.equal(pkg.commissionPercent, 12.5);
  assert.equal(pkg.paidPaise, 200001); assert.equal(pkg.balancePaise, 399999);
  assert.equal(pkg.startDate, iso(0)); assert.equal(pkg.expiresOn, iso(30));
  assert.equal(pkg.payments[0].commissionPaise, 25000);
  assert.equal(pkg.member.name, 'Riya Test'); assert.equal(pkg.trainer.trainerCode, 'TR01');
  assert.ok(await models.TrainerMemberAssignment.exists({ trainerId: trainerA._id, memberId: riya._id, status: 'active' }));
  // A later rate change does not rewrite sold packages.
  await send('put', `${pt()}/rates/${trainerA._id}`, token, { percent: 20 });
  response = await send('post', `${pt()}/packages/${pkg.id}/payments`, token, { amountPaise: 100000, method: 'upi', reference: 'UPI123' });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.payments[0].commissionPaise, 12500);
  response = await send('get', `${pt()}/rates`, token);
  assert.deepEqual(response.body.data.map((row) => [row.trainer.trainerCode, row.percent]), [['TR02', 0], ['TR01', 20]]);
});
test('payments cannot exceed the balance, need a reference for UPI, and stop after cancel', async () => {
  const token = await login();
  const pkg = await sell(token, { payment: { amountPaise: 500000 } });
  let response = await send('post', `${pt()}/packages/${pkg.id}/payments`, token, { amountPaise: 100001 });
  assert.equal(response.body.error.code, 'PT_PAYMENT_EXCEEDS_BALANCE');
  response = await send('post', `${pt()}/packages/${pkg.id}/payments`, token, { amountPaise: 1000, method: 'upi' });
  assert.equal(response.status, 400);
  const racing = await Promise.all([1, 2].map(() => send('post', `${pt()}/packages/${pkg.id}/payments`, token, { amountPaise: 60000 })));
  assert.deepEqual(racing.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await models.PtPackage.findById(pkg.id)).paidPaise, 560000);
  assert.equal((await send('post', `${pt()}/packages/${pkg.id}/cancel`, token)).body.data.status, 'cancelled');
  response = await send('post', `${pt()}/packages/${pkg.id}/payments`, token, { amountPaise: 100 });
  assert.equal(response.body.error.code, 'PT_PACKAGE_CLOSED');
  assert.equal((await send('post', `${pt()}/packages/${pkg.id}/cancel`, token)).body.error.code, 'PT_PACKAGE_CLOSED');
});
test('sessions count down, complete the package and respect dates', async () => {
  const token = await login();
  const pkg = await sell(token, { sessions: 2, validDays: 10 });
  let response = await send('post', `${pt()}/packages/${pkg.id}/sessions`, token, { sessionDate: iso(1) });
  assert.equal(response.body.error.code, 'PT_SESSION_DATE_INVALID');
  response = await send('post', `${pt()}/packages/${pkg.id}/sessions`, token, { note: 'Legs' });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.sessionsLeft, 1);
  assert.deepEqual(response.body.data.sessions.map((s) => [s.sessionDate, s.note]), [[iso(0), 'Legs']]);
  response = await send('post', `${pt()}/packages/${pkg.id}/sessions`, token, {});
  assert.equal(response.body.data.status, 'completed');
  response = await send('post', `${pt()}/packages/${pkg.id}/sessions`, token, {});
  assert.equal(response.body.error.code, 'PT_PACKAGE_CLOSED');
  const future = await sell(token, { startDate: iso(2) });
  response = await send('post', `${pt()}/packages/${future.id}/sessions`, token, {});
  assert.equal(response.body.error.code, 'PT_SESSION_DATE_INVALID');
  assert.equal((await send('post', `${pt()}/packages`, token, { memberId: String(riya._id), trainerId: String(trainerA._id),
    sessions: 1, pricePaise: 0, startDate: iso(-1) })).status, 400);
});
test('a trainer sees only their own packages, without money, and can log sessions', async () => {
  const adminToken = await login();
  const own = await sell(adminToken, { payment: { amountPaise: 1000 } });
  const other = await sell(adminToken, { trainerId: String(trainerB._id) });
  const token = await login(trainer);
  let response = await send('get', `${pt()}/packages`, token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.data.map((row) => row.id), [own.id]);
  for (const key of ['pricePaise', 'paidPaise', 'balancePaise', 'commissionPercent']) assert.equal(key in response.body.data.data[0], false);
  response = await send('get', `${pt()}/packages/${own.id}`, token);
  assert.equal('payments' in response.body.data, false);
  assert.equal((await send('get', `${pt()}/packages/${other.id}`, token)).status, 404);
  assert.equal((await send('get', `${pt()}/packages?trainerId=${trainerB._id}`, token)).status, 403);
  assert.equal((await send('post', `${pt()}/packages/${own.id}/sessions`, token, {})).status, 201);
  assert.equal((await send('post', `${pt()}/packages/${other.id}/sessions`, token, {})).status, 404);
  for (const [method, url, body] of [['post', `${pt()}/packages/${own.id}/payments`, { amountPaise: 100 }],
    ['post', `${pt()}/packages/${own.id}/cancel`], ['get', `${pt()}/commissions`], ['get', `${pt()}/rates`],
    ['put', `${pt()}/rates/${trainerA._id}`, { percent: 50 }], ['post', `${pt()}/packages`, { memberId: String(riya._id),
      trainerId: String(trainerA._id), sessions: 1, pricePaise: 0 }]]) {
    assert.equal((await send(method, url, token, body)).status, 403, `${method} ${url}`);
  }
});
test('commission report sums the period per trainer; other gyms stay isolated', async () => {
  const token = await login();
  await send('put', `${pt()}/rates/${trainerA._id}`, token, { percent: 10 });
  const pkg = await sell(token, { payment: { amountPaise: 300000 } });
  await send('post', `${pt()}/packages/${pkg.id}/sessions`, token, {});
  await sell(token, { trainerId: String(trainerB._id), payment: { amountPaise: 50000 } });
  let response = await send('get', `${pt()}/commissions?preset=today`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.trainers.map((r) => [r.trainer.trainerCode, r.collectedPaise, r.commissionPaise, r.sessions]),
    [['TR01', 300000, 30000, 1], ['TR02', 50000, 0, 0]]);
  assert.deepEqual(response.body.data.totals, { collectedPaise: 350000, commissionPaise: 30000, sessions: 1 });
  response = await send('get', `${pt()}/commissions?from=${iso(-10)}&to=${iso(-1)}`, token);
  assert.equal(response.body.data.totals.collectedPaise, 0);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  response = await send('get', `${pt(gymB)}/packages`, token);
  assert.equal(response.body.data.pagination.total, 0);
  assert.equal((await send('get', `${pt(gymB)}/packages/${pkg.id}`, token)).status, 404);
  const outsider = await member('Other', gymB);
  response = await send('post', `${pt(gymB)}/packages`, token, { memberId: String(outsider._id), trainerId: String(trainerA._id),
    sessions: 1, pricePaise: 0 });
  assert.equal(response.body.error.code, 'TRAINER_NOT_FOUND');
});
test('owner gives a trainer app access: the login is linked to the profile once', async () => {
  const token = await login();
  const staff = (body) => send('post', `/api/v1/gyms/${gymA._id}/staff`, token,
    { email: 'neha@example.com', displayName: 'Neha Iyer', role: 'trainer', password, trainerId: String(trainerB._id), ...body });
  assert.equal((await staff({ role: 'admin' })).status, 400);
  let response = await staff();
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.trainerId, String(trainerB._id));
  assert.equal(String((await models.TrainerProfile.findById(trainerB._id)).userId), response.body.data.userId);
  response = await staff({ email: 'other@example.com' });
  assert.equal(response.body.error.code, 'TRAINER_ALREADY_LINKED');
  // The failed link rolled back the second login's gym access.
  const other = await models.UserAccount.findOne({ email: 'other@example.com' });
  assert.equal(other, null);
  await sell(token, { trainerId: String(trainerB._id) });
  const neha = await login({ email: 'neha@example.com' });
  response = await send('get', `${pt()}/packages`, neha);
  assert.equal(response.body.data.data.length, 1);
  assert.equal(response.body.data.data[0].trainer.trainerCode, 'TR02');
});
test('a trainer takes on any active member as a client, lists and releases them', async () => {
  const token = await login(trainer);
  const mine = `/api/v1/gyms/${gymA._id}/trainer-assignments/me`;
  let response = await send('get', mine, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.pagination.total, 0);
  response = await send('post', mine, token, { memberId: String(riya._id) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.trainerId, String(trainerA._id));
  const again = await Promise.all([1, 2].map(() => send('post', mine, token, { memberId: String(riya._id) })));
  assert.deepEqual(again.map((r) => r.status), [200, 200]);
  assert.equal(await models.TrainerMemberAssignment.countDocuments({ status: 'active' }), 1);
  response = await send('get', mine, token);
  assert.deepEqual(response.body.data.data.map((row) => [row.memberCode, row.firstName]), [[riya.memberCode, 'Riya']]);
  const outsider = await member('Other', gymB);
  assert.equal((await send('post', mine, token, { memberId: String(outsider._id) })).body.error.code, 'MEMBER_NOT_FOUND');
  const inactive = await member('Gone'); await models.MemberProfile.updateOne({ _id: inactive._id }, { status: 'inactive' });
  assert.equal((await send('post', mine, token, { memberId: String(inactive._id) })).status, 403);
  assert.equal((await send('post', mine, await login(), { memberId: String(riya._id) })).status, 403);
  response = await send('delete', `${mine}/${riya._id}`, token);
  assert.equal(response.body.data.status, 'inactive');
  assert.equal((await send('delete', `${mine}/${riya._id}`, token)).status, 404);
  assert.equal((await send('get', mine, token)).body.data.pagination.total, 0);
});
