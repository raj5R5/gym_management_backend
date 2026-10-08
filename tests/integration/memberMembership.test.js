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
const { createApp, createBootstrapApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createSubscriptionService } = require('../../src/modules/subscriptions/subscription.service');
const { createPaymentService } = require('../../src/modules/payments/payment.service');
const { createMemberMembershipService } = require('../../src/modules/memberMembership/membership.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, branchA, branchB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/member-memberships`;
const day = (offset = 0) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };
const input = (overrides = {}) => ({ memberId: String(memberA._id), planId: String(planA._id), ...overrides });
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
function service() {
  const authorizationService = createAuthorizationService(models);
  const dependencies = { ...models, authorizationService };
  return createMemberMembershipService({ ...dependencies, subscriptionService: createSubscriptionService(dependencies), paymentService: createPaymentService(dependencies) });
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
  await models.Branch.create({ gymId: gymA._id, name: 'Other', nameKey: 'other', address });
  branchB = await models.Branch.create({ gymId: gymB._id, name: 'Main', nameKey: 'main', address });
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME02' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, branchId: branchB._id, memberCode: 'ME01' });
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  assignment = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});

const paymentInput = (overrides = {}) => ({ enabled: true, method: 'cash', amountPaise: 50000, paidAt: new Date().toISOString(), ...overrides });
async function purchase(token, overrides = {}, gym = gymA) {
  const response = await send('post', path(gym), token, input(overrides)); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
async function empty() { assert.equal(await models.MemberSubscription.countDocuments(), 0); assert.equal(await models.Payment.countDocuments(), 0); }
test('admin creates subscription only with UTC today default and reused snapshot DTO', async () => {
  const result = await purchase(await login()); assert.equal(result.payment, null); assert.equal(result.subscription.startDate, day());
  assert.equal(result.subscription.memberId, String(memberA._id)); assert.equal(result.subscription.planNameSnapshot, planA.name);
  assert.equal(result.subscription.pricePaiseSnapshot, planA.price); assert.equal(result.subscription.durationDaysSnapshot, 30);
  assert.equal(await models.Payment.countDocuments(), 0);
});
test('disabled payment creates subscription only', async () => {
  const result = await purchase(await login(), { payment: { enabled: false }, startDate: day(-1) });
  assert.equal(result.payment, null); assert.equal(result.subscription.startDate, day(-1));
});
for (const amountPaise of [150000, 50000]) test(`subscription plus ${amountPaise} paise payment succeeds atomically`, async () => {
  const token = await login(); const data = await purchase(token, { payment: paymentInput({ amountPaise }) });
  assert.equal(data.payment.amountPaise, amountPaise); assert.equal(data.payment.status, 'succeeded');
  assert.equal(data.payment.subscriptionId, data.subscription.id); assert.equal(data.payment.recordedByUserId, String(admin._id));
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/payments`, token)).body.meta.pagination.total, 1);
  assert.doesNotMatch(JSON.stringify(data), /password|token|session|__v|"_id"/i);
});
test('trainer may purchase only for current assigned members and recorder remains authenticated trainer', async () => {
  const token = await login(trainer); const result = await purchase(token, { payment: paymentInput() });
  assert.equal(result.payment.recordedByUserId, String(trainer._id));
  error(await send('post', path(), token, input({ memberId: String(memberOther._id) })), 404, 'MEMBER_NOT_FOUND');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { status: 'inactive' });
  error(await send('post', path(), token, input()), 404, 'MEMBER_NOT_FOUND');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  error(await send('post', subscriptionPath(), token, { memberId: String(memberOther._id), membershipPlanId: String(planA._id), startDate: day() }), 403, 'FORBIDDEN');
  error(await send('post', `/api/v1/gyms/${gymA._id}/payments`, token, {}), 403, 'FORBIDDEN');
});
for (const status of ['missing', 'inactive', 'ambiguous']) test(`${status} trainer profile denied`, async () => {
  const token = await login(trainer);
  if (status === 'missing') await models.TrainerProfile.deleteOne({ _id: trainerA._id });
  if (status === 'inactive') await models.TrainerProfile.updateOne({ _id: trainerA._id }, { status: 'inactive' });
  if (status === 'ambiguous') await models.TrainerProfile.create({ gymId: gymA._id, userId: trainer._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543211' });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN'); await empty();
});
test('members and anonymous clients denied', async () => {
  error(await send('post', path(), await login(member), input()), 403, 'FORBIDDEN');
  error(await send('post', path(), undefined, input()), 401, 'INVALID_AUTHENTICATION'); await empty();
});
for (const status of ['inactive', 'suspended']) test(`${status} gym access denied`, async () => {
  const token = await login(); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN'); await empty();
});
test('inactive gym and unauthorized gym denied', async () => {
  const token = await login(); error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' }); error(await send('post', path(), token, input()), 403, 'FORBIDDEN'); await empty();
});
test('foreign/missing members and plans safely rejected', async () => {
  const token = await login();
  for (const memberId of [String(memberB._id), missingId()]) error(await send('post', path(), token, input({ memberId })), 404, 'MEMBER_NOT_FOUND');
  for (const planId of [String(planB._id), missingId()]) error(await send('post', path(), token, input({ planId })), 404, 'PLAN_NOT_FOUND');
  await empty();
});
for (const status of ['inactive', 'suspended']) test(`${status} members cannot be silently reactivated`, async () => {
  await models.MemberProfile.updateOne({ _id: memberA._id }, { status });
  error(await send('post', path(), await login(), input()), 403, 'FORBIDDEN'); await empty();
  assert.equal((await models.MemberProfile.findById(memberA._id)).status, status);
});
test('inactive plan rejected and later plan edits do not alter original snapshot', async () => {
  const token = await login(); await models.MembershipPlan.updateOne({ _id: planA._id }, { status: 'inactive' });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN'); await empty();
  await models.MembershipPlan.updateOne({ _id: planA._id }, { status: 'active' }); const result = await purchase(token);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { name: 'Changed', durationDays: 60, price: 250000 });
  const stored = await models.MemberSubscription.findById(result.subscription.id);
  assert.equal(stored.planNameSnapshot, 'Monthly'); assert.equal(stored.pricePaiseSnapshot, 150000); assert.equal(stored.durationDaysSnapshot, 30);
});
test('overlap or duplicate retry creates no orphan payment', async () => {
  const token = await login(); await purchase(token);
  error(await send('post', path(), token, input({ payment: paymentInput() })), 409, 'SUBSCRIPTION_OVERLAP');
  assert.equal(await models.MemberSubscription.countDocuments(), 1); assert.equal(await models.Payment.countDocuments(), 0);
});
for (const [name, changes, status, code] of [['zero', { amountPaise: 0 }, 400, 'VALIDATION_ERROR'], ['negative', { amountPaise: -1 }, 400, 'VALIDATION_ERROR'],
  ['fractional', { amountPaise: 1.5 }, 400, 'VALIDATION_ERROR'], ['overpayment', { amountPaise: 150001 }, 409, 'PAYMENT_OVERPAYMENT'],
  ['missing reference', { method: 'upi' }, 400, 'VALIDATION_ERROR'], ['unknown method', { method: 'gateway' }, 400, 'VALIDATION_ERROR'],
  ['invalid paidAt', { paidAt: 'bad' }, 400, 'VALIDATION_ERROR']]) test(`${name} payment leaves no subscription or payment`, async () => {
    const before = await models.MemberProfile.findById(memberA._id).lean();
    error(await send('post', path(), await login(), input({ payment: paymentInput(changes) })), status, code); await empty();
    assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), before);
  });
for (const method of ['upi', 'bank_transfer', 'card', 'other']) test(`existing payment method ${method} is supported with valid reference`, async () => {
  const result = await purchase(await login(), { payment: paymentInput({ method, reference: 'REF-1001' }) });
  assert.equal(result.payment.paymentMethod, method); assert.equal(result.payment.transactionReference, 'REF-1001');
});
test('payment reference conflict rolls back new subscription and member version write', async () => {
  const token = await login(); await purchase(token, { payment: paymentInput({ method: 'upi', reference: 'REF-1001' }) });
  const before = await models.MemberProfile.findById(memberOther._id).lean();
  error(await send('post', path(), token, input({ memberId: String(memberOther._id), payment: paymentInput({ method: 'upi', reference: 'REF-1001' }) })), 409, 'DUPLICATE_PAYMENT_REFERENCE');
  assert.equal(await models.MemberSubscription.countDocuments(), 1); assert.equal(await models.Payment.countDocuments(), 1);
  assert.deepEqual(await models.MemberProfile.findById(memberOther._id).lean(), before);
});
test('concurrent purchases serialize the member and leave one complete winning workflow', async () => {
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input({ payment: paymentInput() })), send('post', path(), token, input({ payment: paymentInput() }))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(responses.find((response) => response.status === 409).body.error.code, 'SUBSCRIPTION_OVERLAP');
  assert.equal(await models.MemberSubscription.countDocuments(), 1); assert.equal(await models.Payment.countDocuments(), 1);
});
test('workflow and standalone subscription creation share the same concurrency guard', async () => {
  const token = await login(); const results = await Promise.all([send('post', path(), token, input({ payment: paymentInput() })),
    send('post', subscriptionPath(), token, { memberId: String(memberA._id), membershipPlanId: String(planA._id), startDate: day() })]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]); assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.equal(await models.Payment.countDocuments(), results[0].status === 201 ? 1 : 0);
});
test('strict root and nested fields reject identity, snapshot, payment and trainer injection', async () => {
  const token = await login();
  for (const field of ['gymId', 'trainerId', 'userId', 'recorderUserId', 'recordedByUserId', 'status', 'subscriptionId', 'planNameSnapshot', 'durationDaysSnapshot', 'pricePaiseSnapshot', 'permissions', 'unknown'])
    error(await send('post', path(), token, input({ [field]: 'untrusted' })), 400, 'VALIDATION_ERROR');
  for (const field of ['gymId', 'memberId', 'subscriptionId', 'recordedByUserId', 'status', 'token', 'unknown'])
    error(await send('post', path(), token, input({ payment: paymentInput({ [field]: 'untrusted' }) })), 400, 'VALIDATION_ERROR');
  for (const body of [input({ memberId: 'bad' }), input({ planId: { $ne: null } }), input({ startDate: '2026-02-30' }),
    input({ startDate: day(1) }), input({ payment: { enabled: true } }), input({ payment: { enabled: false, amountPaise: 100 } })])
    error(await send('post', path(), token, body), 400, 'VALIDATION_ERROR');
  error(await send('post', path({ _id: 'bad' }), token, input()), 400, 'VALIDATION_ERROR'); await empty();
});
test('database failure after subscription insertion rolls back all domain changes', async (t) => {
  const token = await login(); const before = await models.MemberProfile.findById(memberA._id).lean();
  t.mock.method(models.Payment, 'create', () => { throw new Error('private database credentials'); });
  const response = await send('post', path(), token, input({ payment: paymentInput() })); error(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /private database credentials/); await empty();
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), before);
});
test('shared domain entry points require an active same-client transaction and valid authorization', async () => {
  await login(); const { auth, authorization } = await context(); const dependencies = { ...models, authorizationService: createAuthorizationService(models) };
  const session = await database.connection.startSession();
  try {
    await assert.rejects(createSubscriptionService(dependencies).createForPurchase(auth, authorization, {}, session), { code: 'INVALID_TRANSACTION_CONTEXT' });
    await assert.rejects(createPaymentService(dependencies).createForPurchase(auth, authorization, {}, session), { code: 'INVALID_TRANSACTION_CONTEXT' });
    await assert.rejects(service().create(auth, undefined, input()), { code: 'FORBIDDEN' });
  } finally { await session.endSession(); }
});
test('one shared session is used without nested transactions or unrelated domain creation', async (t) => {
  const token = await login(); let sessions = 0; const original = database.connection.startSession;
  t.mock.method(database.connection, 'startSession', function (...args) { sessions++; return original.apply(this, args); });
  const memberStatus = (await models.MemberProfile.findById(memberA._id)).status; await purchase(token, { payment: paymentInput() });
  assert.equal(sessions, 1); assert.equal((await models.MemberProfile.findById(memberA._id)).status, memberStatus);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
  assert.equal(await models.TrainerMemberAssignment.countDocuments(), 1);
});
test('bootstrap listener cannot provide an unauthenticated alternate workflow', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
});
test('real standalone MongoDB returns 503 without any subscription or payment', async () => {
  const mongo = await startTestMongo(); const localConfig = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  const db = createDatabase({ logger: createLogger(localConfig) });
  try {
    await db.connect(localConfig); const application = createApp({ config: localConfig, database: db }); const m = db.connection.models;
    await Promise.all(Object.values(m).map((model) => model.createIndexes()));
    const gym = await m.Gym.create({ name: 'Standalone', nameKey: 'standalone' });
    const user = await m.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
    await m.GymAccess.create({ gymId: gym._id, userId: user._id, role: 'admin', status: 'active' });
    const logged = await request(application).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' }); assert.equal(logged.status, 200);
    const response = await request(application).post(`/api/v1/gyms/${gym._id}/member-memberships`).set('Authorization', `Bearer ${logged.body.data.accessToken}`).send({ memberId: missingId(), planId: missingId(), payment: paymentInput() });
    error(response, 503, 'SUBSCRIPTION_STORAGE_UNAVAILABLE'); assert.equal(await m.MemberSubscription.countDocuments(), 0); assert.equal(await m.Payment.countDocuments(), 0);
  } finally { await db.disconnect(); await mongo.stop(); }
});
