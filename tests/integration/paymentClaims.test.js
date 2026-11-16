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

let isolated, database, config, models, app, gymA, gymB, admin, trainer, passwordHash, memberUser, riya, plan;
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
  plan = await models.MembershipPlan.create({ gymId: gymA._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 150000 });
});

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

const claims = (gym = gymA) => `/api/v1/gyms/${gym._id}/payment-claims`;

test('member reports a UPI payment; owner confirms it into a real payment', async () => {
  const sub = await period(riya, -5, 30);
  await pay(sub, 50000);
  const token = await login(memberUser);
  let response = await send('post', me('/payment-claims'), token, { amountPaise: 100001, reference: '123456789012' });
  assert.equal(response.body.error.code, 'CLAIM_EXCEEDS_DUE');
  assert.equal((await send('post', me('/payment-claims'), token, { amountPaise: 100, reference: '12345' })).status, 400);
  response = await send('post', me('/payment-claims'), token, { amountPaise: 60000, reference: '123456789012' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const claim = response.body.data;
  assert.equal(claim.status, 'pending');
  // Pending claims count against what is still claimable.
  response = await send('post', me('/payment-claims'), token, { amountPaise: 40001, reference: '123456789013' });
  assert.equal(response.body.error.code, 'CLAIM_EXCEEDS_DUE');
  response = await send('post', me('/payment-claims'), token, { amountPaise: 100, reference: '123456789012' });
  assert.equal(response.body.error.code, 'DUPLICATE_CLAIM_REFERENCE');
  assert.equal((await send('get', me('/home'), token)).body.data.dues.pendingClaimPaise, 60000);

  const admin = await login();
  response = await send('get', claims(), admin);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.map((row) => [row.member.memberCode, row.amountPaise, row.planName]),
    [[riya.memberCode, 60000, 'Monthly']]);
  response = await send('post', `${claims()}/${claim.id}/confirm`, admin);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.status, 'confirmed');
  const payment = await models.Payment.findById(response.body.data.paymentId).lean();
  assert.deepEqual([payment.amountPaise, payment.paymentMethod, payment.transactionReference, payment.status],
    [60000, 'upi', '123456789012', 'succeeded']);
  assert.equal((await send('post', `${claims()}/${claim.id}/confirm`, admin)).body.error.code, 'CLAIM_ALREADY_DECIDED');
  const home = (await send('get', me('/home'), token)).body.data;
  assert.deepEqual([home.dues.balancePaise, home.dues.pendingClaimPaise], [40000, 0]);
  assert.equal((await send('get', me('/payment-claims'), token)).body.data[0].status, 'confirmed');
});
test('owner rejects with a reason; confirm still cannot overpay; roles and gyms are isolated', async () => {
  const sub = await period(riya, -5, 30, 100000);
  const token = await login(memberUser);
  const a = (await send('post', me('/payment-claims'), token, { amountPaise: 100000, reference: '111111111111' })).body.data;
  const adminToken = await login();
  let response = await send('post', `${claims()}/${a.id}/reject`, adminToken, {});
  assert.equal(response.status, 400);
  response = await send('post', `${claims()}/${a.id}/reject`, adminToken, { reason: 'Not received' });
  assert.deepEqual([response.body.data.status, response.body.data.rejectReason], ['rejected', 'Not received']);
  // A rejected UTR can be reported again (for example after a typo was fixed on the gym side).
  const b = (await send('post', me('/payment-claims'), token, { amountPaise: 100000, reference: '111111111111' })).body.data;
  await pay(sub, 1000); // paid at the desk meanwhile
  response = await send('post', `${claims()}/${b.id}/confirm`, adminToken);
  assert.equal(response.body.error.code, 'PAYMENT_OVERPAYMENT');
  assert.equal((await models.PaymentClaim.findById(b.id)).status, 'pending');
  assert.equal((await send('get', claims(), await login(trainer))).status, 403);
  assert.equal((await send('post', me('/payment-claims'), adminToken, { amountPaise: 1, reference: '222222222222' })).status, 403);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  assert.equal((await send('post', `${claims(gymB)}/${b.id}/confirm`, adminToken)).body.error.code, 'CLAIM_NOT_FOUND');
  assert.deepEqual((await send('get', claims(gymB), adminToken)).body.data, []);
});
test('nothing due: nothing to claim', async () => {
  const sub = await period(riya, -5, 30);
  await pay(sub, 150000);
  const response = await send('post', me('/payment-claims'), await login(memberUser), { amountPaise: 1, reference: '333333333333' });
  assert.equal(response.body.error.code, 'CLAIM_EXCEEDS_DUE');
});
