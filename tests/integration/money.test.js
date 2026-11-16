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

async function pay(sub, amountPaise, overrides = {}) {
  return models.Payment.create({ gymId: sub.gymId, memberId: sub.memberId, subscriptionId: sub._id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date(), status: 'succeeded', recordedByUserId: admin._id, ...overrides });
}
const receiptPath = (payment, gym = gymA) => `/api/v1/gyms/${gym._id}/payments/${payment._id}/receipt`;

// ---- Receipts ----
test('receipt has a stable gym-sequential number, payer, method and balance', async () => {
  const token = await login();
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { contact: { phone: '9876500000' },
    'settings.address': { line1: '12 MG Road', city: 'Pune', postalCode: '411001' } } });
  const aarav = await member('Aarav'); const sub = await period(aarav, -5, 30);
  const first = await pay(sub, 50000, { paymentMethod: 'upi', transactionReference: 'UTR123456' });
  const second = await pay(sub, 40000);
  let response = await send('get', receiptPath(first), token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const receipt = response.body.data;
  assert.equal(receipt.receiptNumber, 'R-00001');
  assert.deepEqual(receipt.gym, { name: 'Gym A', phone: '9876500000', email: null, address: '12 MG Road, Pune, 411001' });
  assert.equal(receipt.member.name, 'Aarav Test');
  assert.deepEqual({ amount: receipt.payment.amountPaise, method: receipt.payment.method, ref: receipt.payment.reference },
    { amount: 50000, method: 'upi', ref: 'UTR123456' });
  assert.deepEqual({ price: receipt.membership.pricePaise, paid: receipt.membership.paidTotalPaise,
    balance: receipt.membership.balancePaise }, { price: 150000, paid: 90000, balance: 60000 });
  assert.doesNotMatch(JSON.stringify(receipt), /gstin|GST/i, 'no GST on receipts');
  response = await send('get', receiptPath(second), token);
  assert.equal(response.body.data.receiptNumber, 'R-00002');
  response = await send('get', receiptPath(first), token);
  assert.equal(response.body.data.receiptNumber, 'R-00001', 'numbers never change');
  assert.equal(await models.PaymentReceipt.countDocuments(), 2);
});
test('concurrent receipt requests for one payment issue a single number', async () => {
  const token = await login();
  const aarav = await member('Aarav'); const sub = await period(aarav, -5, 30);
  const payment = await pay(sub, 150000);
  const responses = await Promise.all([1, 2, 3, 4].map(() => send('get', receiptPath(payment), token)));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(new Set(responses.map((response) => response.body.data.receiptNumber)).size, 1);
  assert.equal(await models.PaymentReceipt.countDocuments(), 1);
});
test('receipts only for succeeded payments, in the gym, for admins', async () => {
  const token = await login();
  const aarav = await member('Aarav'); const sub = await period(aarav, -5, 30);
  const failed = await pay(sub, 1000, { status: 'failed' });
  const response = await send('get', receiptPath(failed), token);
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'RECEIPT_UNAVAILABLE');
  const ok = await pay(sub, 1000);
  assert.equal((await send('get', receiptPath(ok), await login(trainer))).status, 403);
  assert.equal((await send('get', receiptPath(ok, gymB), token)).status, 403);
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/payments/000000000000000000000000/receipt`, token)).status, 404);
  assert.equal(await models.PaymentReceipt.countDocuments(), 0);
});

// ---- Expenses ----
const expensesPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/expenses`;
const iso = (offset) => utcDay(offset).toISOString().slice(0, 10);
test('expenses: create, list a period with category totals, and remove', async () => {
  const token = await login();
  const today = iso(0);
  let response = await send('post', expensesPath(), token, { category: 'rent', amountPaise: 2500000, spentOn: today,
    paymentMethod: 'bank_transfer', note: 'November rent' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const rent = response.body.data;
  await send('post', expensesPath(), token, { category: 'electricity', amountPaise: 400000, spentOn: today });
  await send('post', expensesPath(), token, { category: 'electricity', amountPaise: 100000, spentOn: today });
  response = await send('get', `${expensesPath()}?from=${today}&to=${today}`, token);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.totalPaise, 3000000);
  assert.deepEqual(response.body.data.byCategory, [
    { category: 'rent', amountPaise: 2500000, count: 1 }, { category: 'electricity', amountPaise: 500000, count: 2 }]);
  assert.equal(response.body.data.data.length, 3);
  response = await send('delete', `${expensesPath()}/${rent.id}`, token);
  assert.equal(response.status, 200);
  assert.equal((await send('delete', `${expensesPath()}/${rent.id}`, token)).status, 404, 'already removed');
  response = await send('get', `${expensesPath()}?category=rent`, token);
  assert.equal(response.body.data.totalPaise, 0);
  assert.equal(await models.Expense.countDocuments({ status: 'removed' }), 1, 'removal keeps history');
});
test('expenses reject bad input, future dates and other gyms or roles', async () => {
  const token = await login();
  for (const body of [{}, { category: 'food', amountPaise: 100, spentOn: iso(0) },
    { category: 'rent', amountPaise: 0, spentOn: iso(0) }, { category: 'rent', amountPaise: 1.5, spentOn: iso(0) },
    { category: 'rent', amountPaise: 100, spentOn: iso(2) }, { category: 'rent', amountPaise: 100, spentOn: iso(0), gymId: 'x' }]) {
    assert.equal((await send('post', expensesPath(), token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await send('get', `${expensesPath()}?from=${iso(0)}&to=${iso(-1)}`, token)).status, 400);
  assert.equal((await send('post', expensesPath(), await login(trainer), { category: 'rent', amountPaise: 100, spentOn: iso(0) })).status, 403);
  assert.equal((await send('get', expensesPath(gymB), token)).status, 403);
  assert.equal(await models.Expense.countDocuments(), 0);
});
test('dashboard shows period expenses and profit (which may be negative)', async () => {
  const token = await login();
  const aarav = await member('Aarav'); const sub = await period(aarav, -5, 30);
  await pay(sub, 150000);
  await send('post', expensesPath(), token, { category: 'supplies', amountPaise: 50000, spentOn: iso(0) });
  let response = await send('get', `/api/v1/gyms/${gymA._id}/dashboard`, token);
  assert.deepEqual(response.body.data.expenses, { periodAmountPaise: 50000, profitPaise: 100000 });
  await send('post', expensesPath(), token, { category: 'rent', amountPaise: 300000, spentOn: iso(0) });
  response = await send('get', `/api/v1/gyms/${gymA._id}/dashboard`, token);
  assert.deepEqual(response.body.data.expenses, { periodAmountPaise: 350000, profitPaise: -200000 });
});

// ---- UPI settings ----
test('gym settings store a UPI ID and payee name, and clear them with null', async () => {
  const token = await login();
  const path = `/api/v1/gyms/${gymA._id}/settings`;
  let response = await send('patch', path, token, { upiId: 'IronGym@OKAXIS', upiPayeeName: 'Iron Gym' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.upiId, 'irongym@okaxis');
  assert.equal(response.body.data.upiPayeeName, 'Iron Gym');
  for (const upiId of ['no-at-sign', 'a@', '@bank', 'x y@bank']) {
    assert.equal((await send('patch', path, token, { upiId })).status, 400, upiId);
  }
  response = await send('patch', path, token, { upiId: null, upiPayeeName: null });
  assert.equal(response.body.data.upiId, null);
});
