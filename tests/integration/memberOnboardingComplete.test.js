const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp, createBootstrapApp } = require('../../src/app');
const { startServer } = require('../../src/server');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createMemberService } = require('../../src/modules/members/member.service');
const { createSubscriptionService } = require('../../src/modules/subscriptions/subscription.service');
const { createPaymentService } = require('../../src/modules/payments/payment.service');
const { createCompleteOnboardingService } = require('../../src/modules/memberOnboardingComplete/complete.service');

let isolated, database, config, models, app, gymA, gymB, branchA, branchB, planA, planB, accounts, passwordHash;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/member-onboarding/complete`;
const day = (offset = 0) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const person = (overrides = {}) => ({ memberCode: 'ME01', firstName: 'Alex', lastName: 'River', phone: '9876543210', ...overrides });
const body = (membership) => ({ member: person(), ...(membership === undefined ? {} : { membership }) });
const membership = (overrides = {}) => ({ planId: String(planA._id), ...overrides });
const payment = (overrides = {}) => ({ method: 'cash', amountPaise: 150000, paidAt: new Date().toISOString(), ...overrides });
function error(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.error.code, code);
  assert.equal(response.body.success, false); assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
function send(token, input = body(), key = randomUUID(), gym = gymA, application = app) {
  const pending = request(application).post(path(gym));
  if (token) pending.set('Authorization', `Bearer ${token}`);
  if (key !== null) pending.set('Idempotency-Key', key);
  return pending.send(input);
}
async function login(role = 'admin', application = app) {
  const response = await request(application).post('/api/v1/auth/login').send({ email: accounts[role].email, password, client: 'mobile' });
  assert.equal(response.status, 200); return response.body.data.accessToken;
}
async function counts(member = 0, subscription = 0, recordedPayment = 0, operation = 0) {
  for (const [name, expected] of Object.entries({ MemberProfile: member, MemberSubscription: subscription,
    Payment: recordedPayment, MemberOnboardingOperation: operation })) assert.equal(await models[name].countDocuments(), expected, name);
}
async function complete(token, input = body(), key = randomUUID()) {
  const response = await send(token, input, key); assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store'); return response.body.data;
}
function service(overrides = {}) {
  const dependencies = { ...models, authorizationService: createAuthorizationService(models) };
  return createCompleteOnboardingService({ ...dependencies, memberService: createMemberService(dependencies),
    subscriptionService: createSubscriptionService(dependencies), paymentService: createPaymentService(dependencies), ...overrides });
}
async function context() {
  const auth = { user: accounts.admin, session: await models.AuthSession.findOne({ userId: accounts.admin._id }).lean() };
  return { auth, authorization: await createAuthorizationService(models).requireGymAccess(auth, String(gymA._id)) };
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri,
    ALLOWED_ORIGINS: 'https://frontend.example.com' });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
after(async () => { try { if (database) await database.disconnect(); } finally { if (isolated) await isolated.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({}))); app = createApp({ config, database });
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a' });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b' }); accounts = {};
  for (const label of ['admin', 'admin2', 'trainer', 'member']) {
    accounts[label] = await models.UserAccount.create({ email: `${label}@example.com`, passwordHash, status: 'active' });
    await models.GymAccess.create({ userId: accounts[label]._id, gymId: gymA._id,
      role: label === 'admin2' ? 'admin' : label, status: 'active' });
  }
  const address = { line1: '1 Main Road', city: 'Pune', countryCode: 'IN' };
  branchA = await models.Branch.create({ gymId: gymA._id, name: 'Main', nameKey: 'main', address });
  branchB = await models.Branch.create({ gymId: gymB._id, name: 'Main', nameKey: 'main', address });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});

test('member-only preserves validation, normalization, active status and absence of account side effects', async () => {
  const data = await complete(await login(), { member: person({ memberCode: ' me01 ', firstName: ' Alex ', branchId: String(branchA._id),
    dateOfBirth: '1995-06-12', emergencyContact: { name: 'Pat', phone: '9876543211' } }) });
  assert.equal(data.member.memberCode, 'ME01'); assert.equal(data.member.firstName, 'Alex'); assert.equal(data.member.status, 'active');
  assert.equal(data.subscription, null); assert.equal(data.payment, null);
  assert.deepEqual(data.billing, { planPricePaise: 0, discountPaise: 0, amountReceivedPaise: 0, outstandingBalancePaise: 0 });
  const member = await models.MemberProfile.findById(data.member.id).lean();
  assert.equal(member.phone, '9876543210'); assert.equal(member.userId, undefined); assert.equal(member.emergencyContact.name, 'Pat');
  assert.equal(await models.UserAccount.countDocuments(), 4); assert.equal(await models.GymAccess.countDocuments(), 4);
  await counts(1, 0, 0, 1);
  assert.doesNotMatch(JSON.stringify(data), /phone|dateOfBirth|emergencyContact|password|token|session|__v|"_id"/i);
});
test('membership without payment reuses snapshot and UTC exclusive-end date rules', async () => {
  const data = await complete(await login(), body(membership())); await counts(1, 1, 0, 1);
  assert.equal(data.subscription.startDate, day()); assert.equal(data.subscription.endDate, day(30));
  assert.equal(data.subscription.pricePaiseSnapshot, 150000); assert.equal(data.subscription.isCurrentlyActive, true);
  assert.equal(data.payment, null); assert.equal(data.billing.outstandingBalancePaise, 150000);
});
for (const [label, amount, balance] of [['full', 150000, 0], ['partial', 40000, 110000], ['zero', 0, 150000]])
  test(`${label} initial payment calculates exact outstanding balance and never implies discount`, async () => {
    const data = await complete(await login(), body(membership({ payment: payment({ amountPaise: amount }) })));
    await counts(1, 1, amount ? 1 : 0, 1);
    assert.deepEqual(data.billing, { planPricePaise: 150000, discountPaise: 0, amountReceivedPaise: amount, outstandingBalancePaise: balance });
    if (amount) { assert.equal(data.payment.amountPaise, amount); assert.equal(data.payment.subscriptionId, data.subscription.id); }
    else assert.equal(data.payment, null);
  });
test('zero-priced plan with zero payment is supported without a payment record', async () => {
  await models.MembershipPlan.updateOne({ _id: planA._id }, { price: 0 });
  const data = await complete(await login(), body(membership({ payment: payment({ amountPaise: 0 }) })));
  assert.equal(data.billing.planPricePaise, 0); assert.equal(data.billing.outstandingBalancePaise, 0); await counts(1, 1, 0, 1);
});
test('expired historical subscription stays expired and later plan edits do not change the saved result', async () => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ startDate: day(-40) }));
  const data = await complete(token, input, key); assert.equal(data.subscription.status, 'expired'); assert.equal(data.subscription.isCurrentlyActive, false);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { price: 250000, durationDays: 60, name: 'Changed', status: 'inactive' });
  assert.deepEqual(await complete(token, input, key), data);
  assert.equal((await models.MemberSubscription.findById(data.subscription.id)).pricePaiseSnapshot, 150000);
});
for (const method of ['cash', 'upi', 'bank_transfer', 'card', 'other']) test(`${method} preserves existing payment method and reference semantics`, async () => {
  const data = await complete(await login(), body(membership({ payment: payment({ method, reference: 'REF-1001' }) })));
  assert.equal(data.payment.paymentMethod, method); assert.equal(data.payment.transactionReference, 'REF-1001');
  assert.equal((await models.Payment.findById(data.payment.id)).recordedByUserId.toString(), accounts.admin.id);
});
test('invalid member fields and ownership/role injection are rejected before inserts', async () => {
  const token = await login();
  for (const changes of [{ firstName: '' }, { lastName: 'x'.repeat(81) }, { phone: 'bad' }, { memberCode: 'bad code' },
    { dateOfBirth: '2026-02-30' }, { gymId: String(gymB._id) }, { userId: missingId() }, { role: 'admin' }, { status: 'inactive' },
    { branchId: { $ne: null } }]) error(await send(token, { member: person(changes) }), 400, 'VALIDATION_ERROR');
  const input = body(); delete input.member.phone; error(await send(token, input), 400, 'VALIDATION_ERROR'); await counts();
});
test('strict nested validation rejects invalid dates, amounts, methods, discounts and client totals', async () => {
  const token = await login();
  for (const changes of [{ planId: 'bad' }, { planId: { $ne: null } }, { startDate: '2026-02-30' }, { startDate: day(1) },
    { discountPaise: 1 }, { discountPaise: -1 }, { outstandingBalancePaise: 0 }, { gymId: String(gymB._id) }, { memberId: missingId() }])
    error(await send(token, body(membership(changes))), 400, 'VALIDATION_ERROR');
  for (const changes of [{ amountPaise: -1 }, { amountPaise: 1.5 }, { amountPaise: 1000000001 }, { amountPaise: '100' },
    { paidAt: 'bad' }, { paidAt: `${day(1)}T00:00:00Z` }, { method: 'gateway' }, { method: 'upi' }, { reference: '@bad' },
    { recordedByUserId: missingId() }, { subscriptionId: missingId() }, { discountPaise: 0 }])
    error(await send(token, body(membership({ payment: payment(changes) }))), 400, 'VALIDATION_ERROR');
  for (const extra of [{ discountPaise: 0 }, { payment: payment() }, { gymId: String(gymA._id) }])
    error(await send(token, { ...body(), ...extra }), 400, 'VALIDATION_ERROR'); await counts();
});
test('missing/malformed idempotency keys and malformed gym scope fail closed', async () => {
  const token = await login(); for (const key of [null, 'short', 'bad key!', 'x'.repeat(129)])
    error(await send(token, body(), key), 400, 'VALIDATION_ERROR');
  error(await send(token, body(), randomUUID(), { _id: 'bad' }), 400, 'VALIDATION_ERROR'); await counts();
});
test('missing, cross-gym and inactive plans roll back member insertion', async () => {
  const token = await login();
  for (const planId of [missingId(), String(planB._id)]) error(await send(token, body(membership({ planId }))), 404, 'PLAN_NOT_FOUND');
  await models.MembershipPlan.updateOne({ _id: planA._id }, { status: 'inactive' });
  error(await send(token, body(membership())), 403, 'FORBIDDEN'); await counts();
});
test('missing, foreign and inactive branches cannot escape authorized gym', async () => {
  const token = await login();
  for (const branchId of [missingId(), String(branchB._id)]) error(await send(token, { member: person({ branchId }) }), 404, 'BRANCH_NOT_FOUND');
  await models.Branch.updateOne({ _id: branchA._id }, { status: 'inactive' });
  error(await send(token, { member: person({ branchId: String(branchA._id) }) }), 403, 'FORBIDDEN'); await counts();
});
test('trainers, members, anonymous clients and unauthorized gym denied', async () => {
  for (const role of ['trainer', 'member']) error(await send(await login(role)), 403, 'FORBIDDEN');
  error(await send(undefined), 401, 'INVALID_AUTHENTICATION'); error(await send(await login(), body(), randomUUID(), gymB), 403, 'FORBIDDEN'); await counts();
});
for (const status of ['inactive', 'suspended']) test(`${status} access prevents creation and replay of previous result`, async () => {
  const token = await login(); const key = randomUUID(); await complete(token, body(), key);
  await models.GymAccess.updateOne({ userId: accounts.admin._id }, { status });
  error(await send(token, body(), key), 403, 'FORBIDDEN'); await counts(1, 0, 0, 1);
});
test('inactive gym and inactive account cannot create or retrieve stored results', async () => {
  const token = await login(); const key = randomUUID(); await complete(token, body(), key);
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' }); error(await send(token, body(), key), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'active' });
  await models.UserAccount.updateOne({ _id: accounts.admin._id }, { status: 'suspended' });
  error(await send(token, body(), key), 401, 'INVALID_AUTHENTICATION'); await counts(1, 0, 0, 1);
});
test('overpayment and duplicate payment reference roll back all newly requested records', async () => {
  const token = await login(); error(await send(token, body(membership({ payment: payment({ amountPaise: 150001 }) }))), 409, 'PAYMENT_OVERPAYMENT'); await counts();
  await complete(token, body(membership({ payment: payment({ method: 'upi', reference: 'REF-1001' }) })));
  const second = { member: person({ memberCode: 'ME02' }), membership: membership({ payment: payment({ method: 'upi', reference: 'REF-1001' }) }) };
  error(await send(token, second), 409, 'DUPLICATE_PAYMENT_REFERENCE'); await counts(1, 1, 1, 1);
});
for (const model of ['MemberSubscription', 'Payment', 'MemberOnboardingOperation']) test(`${model} failure after insertion rolls back entire transaction and allows corrected retry`, async (t) => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ payment: payment() }));
  const original = models[model].create;
  const mock = t.mock.method(models[model], 'create', async function (...args) { await original.apply(this, args); throw new Error('private database credentials'); });
  error(await send(token, input, key), 500, 'INTERNAL_SERVER_ERROR'); await counts(); mock.mock.restore();
  await complete(token, input, key); await counts(1, 1, 1, 1);
});
test('failed transaction also rolls back gym and access concurrency writes', async (t) => {
  const token = await login(); const gymBefore = await models.Gym.findById(gymA._id).lean();
  const accessBefore = await models.GymAccess.findOne({ userId: accounts.admin._id }).lean();
  t.mock.method(models.Payment, 'create', () => { throw new Error('private credentials'); });
  const response = await send(token, body(membership({ payment: payment() }))); error(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /private credentials|stack|Mongo/);
  assert.deepEqual(await models.Gym.findById(gymA._id).lean(), gymBefore);
  assert.deepEqual(await models.GymAccess.findOne({ userId: accounts.admin._id }).lean(), accessBefore); await counts();
});
test('duplicate member code preserves existing member and leaves no extra subscription or operation', async () => {
  const token = await login(); const first = await complete(token);
  error(await send(token, body(membership())), 409, 'DUPLICATE_MEMBER_CODE'); await counts(1, 0, 0, 1);
  assert.equal((await models.MemberProfile.findById(first.member.id)).memberCode, 'ME01');
});
test('durable replay uses the saved result after app reconstruction, key order and normalization changes', async () => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ payment: payment({ amountPaise: 40000 }) }));
  const first = await complete(token, input, key); app = createApp({ config, database });
  const reordered = { membership: input.membership, member: { phone: '9876543210', lastName: 'River', firstName: ' Alex ', memberCode: ' me01 ' } };
  assert.deepEqual(await complete(token, reordered, key), first); await counts(1, 1, 1, 1);
  const record = await models.MemberOnboardingOperation.findOne().lean();
  assert.equal(record.result.operationId, first.operationId); assert.notEqual(record.keyDigest, key); assert.equal(record.keyDigest.length, 64);
});
test('same key with changed member, membership or payment payload conflicts', async () => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ payment: payment({ amountPaise: 40000 }) }));
  await complete(token, input, key);
  for (const changes of [{ ...input, member: person({ firstName: 'Changed' }) }, body(),
    { ...input, membership: { ...input.membership, payment: { ...input.membership.payment, amountPaise: 50000 } } }])
    error(await send(token, changes, key), 409, 'IDEMPOTENCY_KEY_CONFLICT'); await counts(1, 1, 1, 1);
});
test('concurrent identical requests through separate app instances commit one workflow', async () => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ payment: payment() }));
  const responses = await Promise.all(Array.from({ length: 4 }, () => send(token, input, key, gymA, createApp({ config, database }))));
  for (const response of responses) { assert.equal(response.status, 201, JSON.stringify(response.body)); assert.deepEqual(response.body.data, responses[0].body.data); }
  await counts(1, 1, 1, 1);
});
test('concurrent differing payloads with one key commit only the winning request', async () => {
  const token = await login(); const key = randomUUID();
  const responses = await Promise.all([send(token, body(membership()), key), send(token, { member: person({ memberCode: 'ME02' }) }, key)]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [201, 409]);
  error(responses.find((res) => res.status === 409), 409, 'IDEMPOTENCY_KEY_CONFLICT');
  await counts(1, responses[0].status === 201 ? 1 : 0, 0, 1);
});
test('idempotency scope is independent across authenticated administrators and gyms', async () => {
  const token = await login(); const second = await login('admin2'); const key = randomUUID();
  const first = await complete(token, body(), key);
  const other = await complete(second, { member: person({ memberCode: 'ME02' }) }, key); assert.notEqual(other.operationId, first.operationId);
  await models.GymAccess.create({ userId: accounts.admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const response = await send(token, body(), key, gymB); assert.equal(response.status, 201); assert.equal(response.body.data.member.gymId, gymB.id);
  assert.notEqual(response.body.data.operationId, first.operationId); await counts(3, 0, 0, 3);
});
test('response failure after commit recovers the exact result without repeating writes', async () => {
  const token = await login(); const key = randomUUID(); const input = body(membership({ payment: payment() }));
  const failingResponseApp = express(); failingResponseApp.use((_req, res, next) => {
    const original = res.json; res.json = function (value) {
      if (value.data?.operationId) throw new Error('Simulated post-commit response failure');
      return original.call(this, value);
    }; next();
  }); failingResponseApp.use(app);
  error(await send(token, input, key, gymA, failingResponseApp), 500, 'INTERNAL_SERVER_ERROR'); await counts(1, 1, 1, 1);
  const saved = await models.MemberOnboardingOperation.findOne().lean(); app = createApp({ config, database });
  assert.deepEqual(await complete(token, input, key), saved.result); await counts(1, 1, 1, 1);
});
test('one shared session, no nested transactions and existing financial readers agree with partial balance', async (t) => {
  const token = await login(); let sessions = 0; const original = database.connection.startSession;
  t.mock.method(database.connection, 'startSession', function (...args) { sessions++; return original.apply(this, args); });
  const data = await complete(token, body(membership({ payment: payment({ amountPaise: 40000 }) }))); assert.equal(sessions, 1);
  const response = await request(app).get(`/api/v1/gyms/${gymA._id}/members/${data.member.id}/memberships`).set('Authorization', `Bearer ${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.subscriptions[0].paymentSummary.remainingBalancePaise, 110000);
});
test('direct service calls reject invalid authorization, session and database authorization failures', async (t) => {
  await login(); const { auth, authorization } = await context();
  await assert.rejects(service().complete(auth, undefined, body(), randomUUID()), { code: 'FORBIDDEN' });
  const memberService = createMemberService({ ...models, authorizationService: createAuthorizationService(models) });
  const session = await database.connection.startSession();
  try { await assert.rejects(memberService.onboardForComplete(auth, authorization, person(), session), { code: 'INVALID_TRANSACTION_CONTEXT' }); }
  finally { await session.endSession(); }
  t.mock.method(models.GymAccess, 'findOneAndUpdate', () => ({ select: () => ({ lean: async () => null }) }));
  await assert.rejects(service().complete(auth, authorization, body(), randomUUID()), { code: 'FORBIDDEN' }); await counts();
});
test('bootstrap listener cannot provide an unauthenticated alternative', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await send(undefined, body(), randomUUID(), gymA, bootstrap), 401, 'INVALID_AUTHENTICATION'); await counts();
});
test('browser preflight permits the idempotency header for trusted origins', async () => {
  const response = await request(app).options(path()).set('Origin', 'https://frontend.example.com')
    .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');
  assert.equal(response.status, 204); assert.match(response.headers['access-control-allow-headers'], /Idempotency-Key/i);
});
test('unique operation index is durable and database-enforced', async () => {
  const data = await complete(await login()); const record = await models.MemberOnboardingOperation.findById(data.operationId).lean();
  const indexes = await models.MemberOnboardingOperation.collection.indexes();
  assert.equal(indexes.find((index) => index.name === 'onboarding_actor_gym_key_unique').unique, true);
  delete record._id; await assert.rejects(models.MemberOnboardingOperation.create(record), { code: 11000 }); await counts(1, 0, 0, 1);
});
test('startup creates the required idempotency index without dropping existing indexes', async () => {
  await models.MemberOnboardingOperation.collection.dropIndexes();
  await models.MemberOnboardingOperation.collection.createIndex({ createdAt: 1 }, { name: 'retained_onboarding_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.MemberOnboardingOperation.collection.indexes();
    assert.equal(indexes.find((index) => index.name === 'onboarding_actor_gym_key_unique').unique, true);
    assert.ok(indexes.some((index) => index.name === 'retained_onboarding_index'));
    assert.equal((await request(lifecycle.app).get('/ready')).status, 200);
  } finally { await lifecycle.shutdown('test'); }
});
test('authorization database lookup failure denies the request without exposing diagnostics', async (t) => {
  const token = await login(); t.mock.method(models.GymAccess, 'findOne', () => { throw new Error('private database credentials'); });
  const response = await send(token); error(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /private database credentials/); await counts();
});
test('legacy member onboarding and purchase/payment endpoints remain usable', async () => {
  const token = await login();
  const profile = await request(app).post(`/api/v1/gyms/${gymA._id}/member-onboarding`).set('Authorization', `Bearer ${token}`).send(person());
  assert.equal(profile.status, 201); assert.equal(profile.body.data.phone, '9876543210');
  const bought = await request(app).post(`/api/v1/gyms/${gymA._id}/member-memberships`).set('Authorization', `Bearer ${token}`)
    .send({ memberId: profile.body.data.id, planId: String(planA._id) }); assert.equal(bought.status, 201);
  const recorded = await request(app).post(`/api/v1/gyms/${gymA._id}/payments`).set('Authorization', `Bearer ${token}`)
    .send({ memberId: profile.body.data.id, subscriptionId: bought.body.data.subscription.id, amountPaise: 40000, paymentMethod: 'cash', paidAt: new Date().toISOString() });
  assert.equal(recorded.status, 201); await counts(1, 1, 1, 0);
});
test('real standalone MongoDB refuses combined writes safely while legacy member-only still works', async () => {
  const local = await startTestMongo(); const localConfig = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: local.uri });
  const db = createDatabase({ logger: createLogger(localConfig) });
  try {
    await db.connect(localConfig); const application = createApp({ config: localConfig, database: db }); const m = db.connection.models;
    await Promise.all(Object.values(m).map((model) => model.createIndexes()));
    const gym = await m.Gym.create({ name: 'Standalone', nameKey: 'standalone' });
    const user = await m.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
    await m.GymAccess.create({ gymId: gym._id, userId: user._id, role: 'admin', status: 'active' });
    const logged = await request(application).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' });
    const token = logged.body.data.accessToken; assert.equal(logged.status, 200);
    for (const input of [body(), body({ planId: missingId() })]) error(await send(token, input, randomUUID(), gym, application), 503, 'ONBOARDING_STORAGE_UNAVAILABLE');
    assert.equal(await m.MemberProfile.countDocuments(), 0); assert.equal(await m.MemberOnboardingOperation.countDocuments(), 0);
    assert.equal((await request(application).post(`/api/v1/gyms/${gym._id}/member-onboarding`).set('Authorization', `Bearer ${token}`).send(person())).status, 201);
  } finally { await db.disconnect(); await local.stop(); }
});
