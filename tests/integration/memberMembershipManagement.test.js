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
const { createMemberSummaryService } = require('../../src/modules/memberSummary/summary.service');
const { createMembershipManagementService } = require('../../src/modules/memberMembershipManagement/management.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, branchA, branchB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
const path = (person = memberA, gym = gymA) => `/api/v1/gyms/${gym._id}/members/${person._id}/memberships`;
const day = (offset = 0) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };
const input = (overrides = {}) => ({ memberId: String(memberA._id), membershipPlanId: String(planA._id), startDate: day(), ...overrides });
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
  return createMembershipManagementService({ summaryService: createMemberSummaryService(dependencies), subscriptionService: createSubscriptionService(dependencies), paymentService: createPaymentService(dependencies) });
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

async function create(token, overrides = {}, gym = gymA) {
  const response = await send('post', subscriptionPath(gym), token, input(overrides)); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
async function list(token, query = '', person = memberA, gym = gymA) {
  const response = await send('get', path(person, gym)+query, token); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
const itemPath = (subscription, person = memberA, gym = gymA) => `${path(person, gym)}/${subscription.id}`;
async function payment(token, subscription, amountPaise = 50000, overrides = {}) {
  const response = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token, { memberId: subscription.memberId,
    subscriptionId: subscription.id, amountPaise, paymentMethod: 'cash', paidAt: new Date().toISOString(), ...overrides });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
test('empty history has null current membership and zero pagination', async () => {
  const result = await list(await login()); assert.equal(result.data.currentMembership, null); assert.deepEqual(result.data.subscriptions, []);
  assert.deepEqual(result.meta.pagination, { page: 1, limit: 20, total: 0 });
});
test('dedicated membership routes authenticate once and retain service-level gym checks', async (t) => {
  const token = await login();
  const subscription = await create(token);
  const sessions = t.mock.method(models.AuthSession, 'findOne');
  const accounts = t.mock.method(models.UserAccount, 'findById');
  const grants = t.mock.method(models.GymAccess, 'findOne');
  for (const [url, expectedGrants] of [[path(), 3], [itemPath(subscription), 4]]) {
    sessions.mock.resetCalls(); accounts.mock.resetCalls(); grants.mock.resetCalls();
    assert.equal((await send('get', url, token)).status, 200);
    assert.equal(sessions.mock.callCount(), 1);
    assert.equal(accounts.mock.callCount(), 1);
    // Dedicated router, member/subscription service, and payment service all
    // independently enforce their existing persisted gym-access checks.
    assert.equal(grants.mock.callCount(), expectedGrants);
  }
});
test('membership route precedence preserves account, session and tenant denials', async () => {
  const token = await login();
  await create(token);
  assert.equal((await send('get', path(), token)).status, 200);
  error(await send('get', path()), 401, 'INVALID_AUTHENTICATION');
  error(await send('get', path(memberB, gymB), token), 403, 'FORBIDDEN');
  error(await send('get', path(memberB), token), 404, 'MEMBER_NOT_FOUND');
  await models.AuthSession.updateMany({ userId: admin._id }, { status: 'revoked' });
  error(await send('get', path(), token), 401, 'INVALID_AUTHENTICATION');
  const replacement = await login();
  await models.UserAccount.updateOne({ _id: admin._id }, { status: 'suspended' });
  error(await send('get', path(), replacement), 401, 'INVALID_AUTHENTICATION');
});
test('admin sees current period and exact partial-payment totals without sensitive fields', async () => {
  const token = await login(); const subscription = await create(token); await payment(token, subscription, 101); await payment(token, subscription, 202);
  const response = await list(token); assert.equal(response.data.currentMembership.id, subscription.id);
  assert.deepEqual(response.data.currentMembership.paymentSummary, { totalSuccessfulPaidPaise: 303, remainingBalancePaise: 149697 });
  assert.deepEqual(response.data.subscriptions[0].paymentSummary, response.data.currentMembership.paymentSummary);
  assert.deepEqual(Object.keys(response.data.member).sort(), ['id', 'memberCode', 'firstName', 'lastName'].sort());
  assert.doesNotMatch(JSON.stringify(response), /password|token|session|__v|"_id"|email|phone/i);
  const item = await send('get', itemPath(subscription), token); assert.equal(item.status, 200);
  assert.deepEqual(item.body.data.paymentSummary, response.data.currentMembership.paymentSummary);
  assert.equal(item.headers['cache-control'], 'no-store'); assert.equal(item.body.meta.requestId, item.headers['x-request-id']);
});
test('full payment leaves zero balance and unsuccessful payments never count', async () => {
  const token = await login(); const subscription = await create(token); await payment(token, subscription, 150000);
  for (const status of ['pending', 'failed', 'cancelled']) await models.Payment.create({ gymId: gymA._id, memberId: memberA._id,
    subscriptionId: subscription.id, amountPaise: 999, paymentMethod: 'cash', paidAt: new Date(), status });
  assert.deepEqual((await send('get', itemPath(subscription), token)).body.data.paymentSummary, { totalSuccessfulPaidPaise: 150000, remainingBalancePaise: 0 });
});
test('trainer sees and cancels only currently assigned member subscriptions', async () => {
  const adminToken = await login(); const subscription = await create(adminToken);
  const other = await create(adminToken, { memberId: String(memberOther._id) }); const token = await login(trainer);
  assert.equal((await list(token)).data.currentMembership.id, subscription.id);
  error(await send('get', path(memberOther), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('get', itemPath(other, memberOther), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('post', itemPath(other, memberOther)+'/cancel', token, {}), 404, 'MEMBER_NOT_FOUND');
  assert.equal((await send('post', itemPath(subscription)+'/cancel', token, {})).status, 200);
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { status: 'inactive' });
  for (const [method, url, body] of [['get', path()], ['get', itemPath(subscription)], ['post', itemPath(subscription)+'/cancel', {}]])
    error(await send(method, url, token, body), 404, 'MEMBER_NOT_FOUND');
});
for (const condition of ['missing', 'inactive', 'ambiguous']) test(`${condition} trainer profile denied`, async () => {
  const token = await login(trainer);
  if (condition === 'missing') await models.TrainerProfile.deleteOne({ _id: trainerA._id });
  if (condition === 'inactive') await models.TrainerProfile.updateOne({ _id: trainerA._id }, { status: 'inactive' });
  if (condition === 'ambiguous') await models.TrainerProfile.create({ gymId: gymA._id, userId: trainer._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543211' });
  error(await send('get', path(), token), 403, 'FORBIDDEN');
});
test('members and anonymous clients denied on all endpoints', async () => {
  const adminToken = await login(); const subscription = await create(adminToken); const token = await login(member);
  for (const [method, url, body] of [['get', path()], ['get', itemPath(subscription)], ['post', itemPath(subscription)+'/cancel', {}]]) {
    error(await send(method, url, token, body), 403, 'FORBIDDEN'); error(await send(method, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});
for (const status of ['inactive', 'suspended']) test(`${status} access denies management`, async () => {
  const token = await login(); const subscription = await create(token); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  for (const [method, url, body] of [['get', path()], ['post', itemPath(subscription)+'/cancel', {}]]) error(await send(method, url, token, body), 403, 'FORBIDDEN');
});
test('inactive and unauthorized gyms denied', async () => {
  const token = await login(); error(await send('get', path(memberB, gymB), token), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' }); error(await send('get', path(), token), 403, 'FORBIDDEN');
});
test('trainer cannot read or cancel across gym boundaries', async () => {
  const adminToken = await login();
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(adminToken, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  const token = await login(trainer);
  for (const [method, url, body] of [['get', path(memberB, gymB)], ['get', itemPath(foreign, memberB, gymB)], ['post', itemPath(foreign, memberB, gymB)+'/cancel', {}]])
    error(await send(method, url, token, body), 403, 'FORBIDDEN');
  for (const [method, url, body] of [['get', path(memberB)], ['get', itemPath(foreign, memberB)], ['post', itemPath(foreign, memberB)+'/cancel', {}]])
    error(await send(method, url, token, body), 404, 'MEMBER_NOT_FOUND');
  assert.equal((await models.MemberSubscription.findById(foreign.id)).status, 'active');
});
test('same-gym wrong member and cross-gym subscription IDs cannot be read or cancelled', async () => {
  const token = await login(); const subscription = await create(token); const other = await create(token, { memberId: String(memberOther._id) });
  for (const url of [itemPath(other), itemPath(subscription, memberOther)]) {
    error(await send('get', url, token), 404, 'SUBSCRIPTION_NOT_FOUND'); error(await send('post', url+'/cancel', token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  }
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  error(await send('get', itemPath(foreign), token), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('post', itemPath(foreign)+'/cancel', token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('get', path(memberB), token), 404, 'MEMBER_NOT_FOUND');
  assert.equal((await models.MemberSubscription.findById(foreign.id)).status, 'active');
});
test('cancellation is idempotent, preserves snapshots, history and all successful payments', async () => {
  const token = await login(); const subscription = await create(token); await payment(token, subscription);
  const original = await models.MemberSubscription.findById(subscription.id).lean(); const payments = await models.Payment.find().lean();
  const first = await send('post', itemPath(subscription)+'/cancel', token, { cancellationReason: 'Requested' }); assert.equal(first.status, 200);
  assert.equal(first.body.data.status, 'cancelled'); const second = await send('post', itemPath(subscription)+'/cancel', token, { cancellationReason: 'Ignored retry' });
  assert.equal(second.status, 200); assert.equal(second.body.data.cancelledAt, first.body.data.cancelledAt); assert.equal(second.body.data.cancellationReason, 'Requested');
  const after = await models.MemberSubscription.findById(subscription.id).lean();
  for (const field of ['planNameSnapshot', 'pricePaiseSnapshot', 'durationDaysSnapshot', 'startDate', 'endDate']) assert.deepEqual(after[field], original[field]);
  assert.deepEqual(await models.Payment.find().lean(), payments); const history = await list(token);
  assert.equal(history.data.currentMembership, null); assert.equal(history.data.subscriptions[0].status, 'cancelled');
  assert.deepEqual(history.data.subscriptions[0].paymentSummary, { totalSuccessfulPaidPaise: 50000, remainingBalancePaise: 100000 });
});
test('expired renewal respects exclusive boundaries and blocks another early renewal', async () => {
  const token = await login(); const old = await create(token, { startDate: day(-30) });
  const renewal = await send('post', `${subscriptionPath()}/${old.id}/renew`, token, {}); assert.equal(renewal.status, 201);
  assert.equal((await list(token)).data.currentMembership.id, renewal.body.data.id);
  error(await send('post', `${subscriptionPath()}/${renewal.body.data.id}/renew`, token, {}), 409, 'ACTIVE_MEMBERSHIP_EXISTS');
  const before = await models.MemberSubscription.findById(renewal.body.data.id).lean();
  await send('post', itemPath(old)+'/cancel', token, {});
  assert.deepEqual(await models.MemberSubscription.findById(renewal.body.data.id).lean(), before);
  const result = await list(token); assert.equal(result.data.currentMembership.id, renewal.body.data.id);
  assert.equal(result.data.subscriptions[0].isCurrentlyActive, true);
  error(await send('post', `${subscriptionPath()}/${old.id}/renew`, token, {}), 409, 'SUBSCRIPTION_CANCELLED');
});
test('current membership ignores mutable plan status and preserves historical terms', async () => {
  const token = await login(); const subscription = await create(token);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { name: 'Different', price: 300000, durationDays: 60, status: 'inactive' });
  const result = await list(token); assert.equal(result.data.currentMembership.id, subscription.id); assert.equal(result.data.currentMembership.pricePaiseSnapshot, 150000);
  assert.equal(result.data.currentMembership.planNameSnapshot, 'Monthly');
});
test('ambiguous effective periods fail closed even when history filters would hide them', async () => {
  const token = await login(); const subscription = await create(token); const raw = await models.MemberSubscription.findById(subscription.id).lean(); delete raw._id;
  await models.MemberSubscription.create(raw);
  error(await send('get', path()+'?status=expired&limit=1', token), 500, 'INTERNAL_SERVER_ERROR');
});
test('history pagination and start-date filters never change current selection', async () => {
  const token = await login(); const old = await create(token, { startDate: day(-30) }); const renewal = await send('post', `${subscriptionPath()}/${old.id}/renew`, token, {});
  const current = renewal.body.data;
  const result = await list(token, `?status=expired&from=${day(-30)}&to=${day(-30)}&page=1&limit=1`);
  assert.deepEqual(result.meta.pagination, { page: 1, limit: 1, total: 1 }); assert.equal(result.data.subscriptions[0].id, old.id);
  assert.equal(result.data.currentMembership.id, current.id);
  const emptyPage = await list(token, '?page=10000&limit=100'); assert.deepEqual(emptyPage.data.subscriptions, []); assert.equal(emptyPage.data.currentMembership.id, current.id);
});
test('newest startDate and _id provide deterministic history order', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-90) }); const second = await create(token, { startDate: day(-60) }); const current = await create(token);
  const raw = await models.MemberSubscription.findById(first.id).lean(); delete raw._id;
  const tied = await models.MemberSubscription.create({ ...raw, status: 'cancelled', cancelledAt: new Date() });
  assert.deepEqual((await list(token)).data.subscriptions.map((record) => record.id), [current.id, second.id, String(tied._id), first.id]);
});
test('invalid dates, IDs, unknown fields and filters cannot expand scope', async () => {
  const token = await login(trainer);
  for (const query of ['trainerId='+trainerA._id, 'memberId='+memberOther._id, 'gymId='+gymB._id, 'status=paused', 'from=2026-02-30', 'from=2026-10-08&to=2026-10-07',
    'from[$gt]=2026-01-01', 'page=0', 'page=10001', 'limit=101', 'limit=0', 'status=active&status=expired']) error(await send('get', path()+'?'+query, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'bad' }), token), 400, 'VALIDATION_ERROR');
  const adminToken = await login(); const subscription = await create(adminToken);
  error(await send('get', itemPath(subscription)+'?trainerId='+trainerA._id, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path()+'/bad', token), 400, 'VALIDATION_ERROR');
  for (const field of ['status', 'pricePaiseSnapshot', 'gymId', 'memberId', 'trainerId', 'refund']) error(await send('post', itemPath(subscription)+'/cancel', adminToken, { [field]: 'untrusted' }), 400, 'VALIDATION_ERROR');
});
test('payment corruption fails closed instead of exposing another member or invalid totals', async () => {
  const token = await login(); const subscription = await create(token); const paid = await payment(token, subscription);
  for (const update of [{ memberId: memberOther._id }, { amountPaise: 1.5 }, { amountPaise: -1 }, { amountPaise: 150001 }]) {
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: update });
    error(await send('get', path(), token), 500, 'INTERNAL_SERVER_ERROR');
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: { memberId: memberA._id, amountPaise: 50000 } });
  }
});
test('other subscriptions and gyms do not leak payments into member summaries', async () => {
  const token = await login(); const subscription = await create(token); const other = await create(token, { memberId: String(memberOther._id) });
  await payment(token, other, 101);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  await models.Payment.create({ gymId: gymB._id, memberId: memberB._id, subscriptionId: foreign.id, amountPaise: 202,
    paymentMethod: 'cash', paidAt: new Date(), status: 'succeeded' });
  assert.deepEqual((await send('get', itemPath(subscription), token)).body.data.paymentSummary, { totalSuccessfulPaidPaise: 0, remainingBalancePaise: 150000 });
});
test('database read/cancel failures return safe errors and preserve historical state', async (t) => {
  const token = await login(); const subscription = await create(token);
  for (const [model, method, url, verb] of [[models.MemberSubscription, 'aggregate', path(), 'get'], [models.Payment, 'aggregate', path(), 'get'],
    [models.MemberSubscription, 'findOneAndUpdate', itemPath(subscription)+'/cancel', 'post']]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private storage credentials'); });
    const response = await send(verb, url, token, verb === 'post' ? {} : undefined); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /private storage credentials/); mock.mock.restore();
  }
  assert.equal((await models.MemberSubscription.findById(subscription.id)).status, 'active');
});
test('reads make no writes and use one batch payment aggregation rather than N+1 calls', async (t) => {
  const token = await login(); await create(token); let count = 0; const original = models.Payment.aggregate;
  t.mock.method(models.Payment, 'aggregate', function (...args) { count++; return original.apply(this, args); });
  for (const model of Object.values(models)) for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany'])
    t.mock.method(model, method, () => { throw new Error('Read attempted mutation'); });
  await list(token); assert.equal(count, 1);
});
test('bootstrap has no unauthenticated management bypass and unsupported mutations remain absent', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION'); const token = await login(); const subscription = await create(token);
  error(await send('patch', itemPath(subscription), token, { status: 'active' }), 404, 'NOT_FOUND');
  error(await send('delete', itemPath(subscription), token), 404, 'NOT_FOUND');
});
test('service rejects incomplete and stale gym context', async () => {
  await login(); const { auth, authorization } = await context();
  await assert.rejects(service().list(auth, undefined, String(memberA._id), {}), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { status: 'inactive' });
  await assert.rejects(service().list(auth, authorization, String(memberA._id), {}), { code: 'FORBIDDEN' });
});
test('missing member and missing subscription use safe not-found responses', async () => {
  const token = await login(); error(await send('get', path({ _id: missingId() }), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('get', path()+'/'+missingId(), token), 404, 'SUBSCRIPTION_NOT_FOUND');
});
