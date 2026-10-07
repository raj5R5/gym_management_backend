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
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
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
async function create(token, overrides = {}, gym = gymA) {
  const response = await send('post', path(gym), token, input(overrides));
  assert.equal(response.status, 201);
  return response.body.data;
}
function service() {
  return createSubscriptionService({ ...models, authorizationService: createAuthorizationService(models) });
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
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME02' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, memberCode: 'ME01' });
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  assignment = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});

const renewalPath = (subscription, gym = gymA) => `${path(gym)}/${subscription.id}/renew`;
async function renew(token, subscription, body = {}) {
  const response = await send('post', renewalPath(subscription), token, body);
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
function historical(record) { const { __v, ...fields } = record; assert.ok(Number.isInteger(__v)); return fields; }

test('early renewal creates an adjacent new period without rewriting history or collecting money', async () => {
  const token = await login(); const first = await create(token);
  const old = await models.MemberSubscription.findById(first.id).lean();
  const second = await renew(token, first, { notes: ' Renewal ' });
  assert.notEqual(second.id, first.id); assert.equal(second.previousSubscriptionId, first.id);
  assert.equal(first.previousSubscriptionId, null); assert.equal(second.startDate, first.endDate);
  assert.equal(second.endDate, day(60)); assert.equal(second.notes, 'Renewal');
  assert.equal(second.gymId, first.gymId); assert.equal(second.memberId, first.memberId);
  assert.equal(second.membershipPlanId, first.membershipPlanId);
  assert.equal(second.status, 'active'); assert.equal(second.isCurrentlyActive, false);
  assert.equal(first.isCurrentlyActive, true);
  const after = await models.MemberSubscription.findById(first.id).lean();
  assert.deepEqual(historical(after), historical(old)); assert.equal(after.__v, old.__v + 1);
  assert.deepEqual((await send('get', `${path()}/${first.id}`, token)).body.data, first);
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
  assert.equal(await models.Payment.countDocuments(), 0);
});

test('renewal snapshots the current name, price and duration while preserving old commercial terms', async () => {
  const token = await login(); const first = await create(token);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { name: 'Revised', normalizedName: 'revised', durationDays: 45, price: 180000 } });
  const second = await renew(token, first);
  assert.equal(second.planNameSnapshot, 'Revised'); assert.equal(second.durationDaysSnapshot, 45);
  assert.equal(second.pricePaiseSnapshot, 180000); assert.equal(second.endDate, day(75));
  const original = (await send('get', `${path()}/${first.id}`, token)).body.data;
  assert.deepEqual(original, first);
});

test('inactive and missing plans reject renewal and roll back all version writes', async () => {
  const token = await login(); const first = await create(token);
  const before = await models.MemberSubscription.findById(first.id).lean();
  const memberBefore = await models.MemberProfile.findById(memberA._id).lean();
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { status: 'inactive' } });
  error(await send('post', renewalPath(first), token, {}), 403, 'FORBIDDEN');
  await models.MembershipPlan.deleteOne({ _id: planA._id });
  error(await send('post', renewalPath(first), token, {}), 404, 'PLAN_NOT_FOUND');
  assert.deepEqual(await models.MemberSubscription.findById(first.id).lean(), before);
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), memberBefore);
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('inactive, suspended, missing or cross-gym member references cannot be renewed', async () => {
  const token = await login(); const first = await create(token);
  for (const status of ['inactive', 'suspended']) {
    await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { status } });
    error(await send('post', renewalPath(first), token, {}), 403, 'FORBIDDEN');
  }
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { memberId: memberB._id } });
  error(await send('post', renewalPath(first), token, {}), 404, 'MEMBER_NOT_FOUND');
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { memberId: memberA._id } });
  await models.MemberProfile.deleteOne({ _id: memberA._id });
  error(await send('post', renewalPath(first), token, {}), 404, 'MEMBER_NOT_FOUND');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('cancelled predecessor cannot be renewed and cancellation remains idempotent', async () => {
  const token = await login(); const first = await create(token);
  const cancelled = await send('patch', `${path()}/${first.id}/cancel`, token, { cancellationReason: 'Requested' });
  const old = await models.MemberSubscription.findById(first.id).lean();
  error(await send('post', renewalPath(first), token, {}), 409, 'SUBSCRIPTION_CANCELLED');
  assert.deepEqual(await models.MemberSubscription.findById(first.id).lean(), old);
  assert.deepEqual((await send('patch', `${path()}/${first.id}/cancel`, token, {})).body.data, cancelled.body.data);
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('custom dates allow explicit gaps but reject any start inside the predecessor period', async () => {
  const token = await login(); const first = await create(token);
  error(await send('post', renewalPath(first), token, { startDate: day(20) }), 409, 'SUBSCRIPTION_OVERLAP');
  const second = await renew(token, first, { startDate: day(35) });
  assert.equal(second.startDate, day(35)); assert.equal(second.endDate, day(65));
});

test('renewal checks all other non-cancelled periods and allows adjacency', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-60) });
  const other = await create(token, { startDate: day(-30) });
  error(await send('post', renewalPath(first), token, {}), 409, 'SUBSCRIPTION_OVERLAP');
  const second = await renew(token, first, { startDate: other.endDate });
  assert.equal(second.startDate, day()); assert.equal(second.isCurrentlyActive, true);
});

test('expired renewals expire effectively without writes and cancelled future periods release overlap', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-90) });
  const second = await renew(token, first); assert.equal(second.status, 'expired');
  assert.equal(second.isCurrentlyActive, false);
  const current = await create(token); const future = await renew(token, current);
  const cancelled = await send('patch', `${path()}/${future.id}/cancel`, token, {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.data.status, 'cancelled');
  error(await send('post', renewalPath(future), token, {}), 409, 'SUBSCRIPTION_CANCELLED');
  // One direct successor remains a historical rule even when it is cancelled.
  error(await send('post', renewalPath(current), token, {}), 409, 'SUBSCRIPTION_ALREADY_RENEWED');
  assert.equal(await models.Payment.countDocuments(), 0);
});

test('A to B to C supports early renewals with independent snapshots and bounded history', async () => {
  const token = await login(); const first = await create(token); const second = await renew(token, first);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { price: 190000 } });
  const third = await renew(token, second);
  assert.equal(third.previousSubscriptionId, second.id); assert.equal(third.startDate, second.endDate);
  assert.equal(third.endDate, day(90)); assert.equal(third.pricePaiseSnapshot, 190000);
  assert.equal(second.pricePaiseSnapshot, 150000);
  const listed = await send('get', path(), token); assert.equal(listed.status, 200);
  assert.equal(listed.body.meta.pagination.total, 3);
  for (const data of listed.body.data) assert.equal('predecessor' in data, false);
  const active = await send('get', `${path()}?status=active`, token);
  assert.equal(active.body.data.length, 3); assert.equal(active.body.data.filter((data) => data.isCurrentlyActive).length, 1);
  assert.equal((await send('get', `${path()}/${third.id}`, token)).body.data.previousSubscriptionId, second.id);
});

test('two concurrent admins produce exactly one successor, even with different custom dates', async () => {
  const token = await login(); const first = await create(token);
  const otherAdmin = await models.UserAccount.create({ email: 'other-admin@example.com', passwordHash, status: 'active' });
  await models.GymAccess.create({ userId: otherAdmin._id, gymId: gymA._id, role: 'admin', status: 'active' });
  const secondToken = await login(otherAdmin);
  const results = await Promise.all([send('post', renewalPath(first), token, {}),
    send('post', renewalPath(first), secondToken, { startDate: day(65) })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'SUBSCRIPTION_ALREADY_RENEWED');
  assert.equal(await models.MemberSubscription.countDocuments({ previousSubscriptionId: first.id }), 1);
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
  assert.equal((await models.MemberSubscription.findById(first.id)).__v, 1);
});

test('normal creation and renewal compete through the same member lock', async () => {
  const token = await login(); const first = await create(token, { startDate: day(-30) });
  const results = await Promise.all([send('post', renewalPath(first), token, {}), send('post', path(), token, input())]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'SUBSCRIPTION_OVERLAP');
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
});

test('cancellation during renewal forces a retry and rejects the cancelled predecessor', async (t) => {
  const token = await login(); const first = await create(token); let cancelled = false;
  const original = models.MemberSubscription.findOne.bind(models.MemberSubscription);
  t.mock.method(models.MemberSubscription, 'findOne', (...args) => {
    const query = original(...args); const lean = query.lean.bind(query);
    query.lean = async (...options) => {
      const record = await lean(...options);
      if (!cancelled) {
        cancelled = true;
        assert.equal((await send('patch', `${path()}/${first.id}/cancel`, token, {})).status, 200);
      }
      return record;
    };
    return query;
  });
  error(await send('post', renewalPath(first), token, {}), 409, 'SUBSCRIPTION_CANCELLED');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.equal((await models.MemberSubscription.findById(first.id)).__v, 0);
});

test('failed insert rolls back predecessor/member counters and exposes no database details', async (t) => {
  const token = await login(); const first = await create(token);
  const before = await models.MemberSubscription.findById(first.id).lean();
  const profile = await models.MemberProfile.findById(memberA._id).lean();
  t.mock.method(models.MemberSubscription, 'create', () => { throw new Error('private database credentials'); });
  const response = await send('post', renewalPath(first), token, {});
  error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.equal(JSON.stringify(response.body).includes('private'), false);
  assert.deepEqual(await models.MemberSubscription.findById(first.id).lean(), before);
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), profile);
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('authentication and explicit role guards deny renewals including on the bootstrap listener', async () => {
  const token = await login(); const first = await create(token);
  error(await send('post', renewalPath(first), undefined, {}), 401, 'INVALID_AUTHENTICATION');
  for (const account of [trainer, member]) error(await send('post', renewalPath(first), await login(account), {}), 403, 'FORBIDDEN');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(renewalPath(first)).send({}), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('post', `/api/v1/subscriptions/${first.id}/renew`, token, {})).status, 404);
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('inactive/suspended grants, inactive gyms and inactive accounts fail closed', async () => {
  const token = await login(); const first = await create(token);
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } });
    error(await send('post', renewalPath(first), token, {}), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('post', renewalPath(first), token, {}), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'active' } });
  await models.UserAccount.updateOne({ _id: admin._id }, { $set: { status: 'suspended' } });
  error(await send('post', renewalPath(first), token, {}), 401, 'INVALID_AUTHENTICATION');
});

test('cross-gym IDs fail even for an admin with access to both gyms', async () => {
  const token = await login(); const first = await create(token);
  error(await send('post', renewalPath(first, gymB), token, {}), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  error(await send('post', renewalPath(first, gymB), token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  const foreign = await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  error(await send('post', renewalPath(foreign), token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('post', `${path()}/${missingId()}/renew`, token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  assert.equal(await models.MemberSubscription.countDocuments(), 2);
});

test('strict renewal rejects substituted IDs, commercial terms, operators and unsafe values', async () => {
  const token = await login(); const first = await create(token);
  const protectedFields = ['gymId', 'memberId', 'membershipPlanId', 'previousSubscriptionId', 'userId', 'role',
    'pricePaiseSnapshot', 'durationDaysSnapshot', 'planNameSnapshot', 'endDate', 'status', 'createdAt', 'cancelledAt'];
  for (const field of protectedFields) error(await send('post', renewalPath(first), token, { [field]: missingId() }), 400, 'VALIDATION_ERROR');
  for (const body of [{ $set: { pricePaiseSnapshot: 0 } }, { startDate: { $ne: null } }, { startDate: '2024-02-30' },
    { startDate: '0000-01-01' }, { startDate: '2026-10-07T00:00:00Z' }, { notes: '' }, { notes: 'x'.repeat(2001) },
    { notes: null }, { startDate: null }, { unknown: true }, []])
    error(await send('post', renewalPath(first), token, body), 400, 'VALIDATION_ERROR');
  for (const url of [`${path()}/invalid/renew`, `${path({ _id: 'invalid' })}/${first.id}/renew`])
    error(await send('post', url, token, {}), 400, 'VALIDATION_ERROR');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
});

test('renewal accepts no body and rejects end-date overflow with complete rollback', async () => {
  const token = await login(); const first = await create(token);
  assert.equal((await send('post', renewalPath(first), token)).status, 201);
  const other = await create(token, { memberId: String(memberOther._id) });
  error(await send('post', renewalPath(other), token, { startDate: '9999-12-31' }), 400, 'VALIDATION_ERROR');
  assert.equal(await models.MemberSubscription.countDocuments(), 3);
  assert.equal((await models.MemberSubscription.findById(other.id)).__v, 0);
});

test('renewal relationships are immutable and cyclic self-references fail validation', async () => {
  const token = await login(); const first = await create(token); const second = await renew(token, first);
  await models.MemberSubscription.updateOne({ _id: second.id }, { $set: { previousSubscriptionId: second.id } }, { runValidators: true });
  assert.equal(String((await models.MemberSubscription.findById(second.id)).previousSubscriptionId), first.id);
  const id = new mongoose.Types.ObjectId();
  await assert.rejects(models.MemberSubscription.create({ _id: id, gymId: gymA._id, memberId: memberOther._id,
    membershipPlanId: planA._id, previousSubscriptionId: id, startDate: new Date(`${day()}T00:00:00Z`),
    endDate: new Date(`${day(30)}T00:00:00Z`), planNameSnapshot: 'Monthly', durationDaysSnapshot: 30, pricePaiseSnapshot: 150000 }),
  { name: 'ValidationError' });
});

test('corrupt cross-gym plan and predecessor references fail closed in renewal and reads', async () => {
  const token = await login(); const first = await create(token); const second = await renew(token, first);
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(second.id) }, { $set: { previousSubscriptionId: new mongoose.Types.ObjectId() } });
  error(await send('post', renewalPath(second), token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  error(await send('get', `${path()}/${second.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 1);
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { membershipPlanId: planB._id } });
  error(await send('post', renewalPath(first), token, {}), 404, 'PLAN_NOT_FOUND');
  // A different predecessor without a successor cannot load a foreign-gym plan.
  const other = await create(token, { memberId: String(memberOther._id) });
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { membershipPlanId: planB._id } });
  error(await send('post', renewalPath(other), token, {}), 404, 'PLAN_NOT_FOUND');
});

test('database lookup failures and stale service authorization cannot create renewals', async (t) => {
  const token = await login(); const first = await create(token);
  for (const [model, method] of [[models.GymAccess, 'findOne'], [models.Gym, 'findOne'],
    [models.MemberSubscription, 'findOne'], [models.MemberSubscription, 'findOneAndUpdate'],
    [models.MemberSubscription, 'exists'], [models.MemberProfile, 'findOneAndUpdate'], [models.MembershipPlan, 'findOne']]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database details'); });
    const response = await send('post', renewalPath(first), token, {}); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(JSON.stringify(response.body).includes('private'), false); mocked.mock.restore();
  }
  const { auth, authorization } = await context();
  await assert.rejects(service().renew(auth, undefined, first.id, {}), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  await assert.rejects(service().renew(auth, authorization, first.id, {}), { code: 'FORBIDDEN' });
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.equal((await models.MemberSubscription.findById(first.id)).__v, 0);
});

test('payments remain independent and existing payment history is unchanged by renewal', async () => {
  const token = await login(); const first = await create(token);
  const payment = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token,
    { memberId: first.memberId, subscriptionId: first.id, amountPaise: 150000, paymentMethod: 'cash', paidAt: new Date().toISOString() });
  assert.equal(payment.status, 201);
  const before = await models.Payment.findById(payment.body.data.id).lean();
  const second = await renew(token, first);
  assert.equal(await models.Payment.countDocuments(), 1); assert.deepEqual(await models.Payment.findById(before._id).lean(), before);
  const later = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token,
    { memberId: second.memberId, subscriptionId: second.id, amountPaise: 150000, paymentMethod: 'cash', paidAt: new Date().toISOString() });
  assert.equal(later.status, 201); assert.equal(later.body.data.subscriptionId, second.id);
});

test('predecessor index is nonunique and no renewal collection or payment fields are introduced', async () => {
  const indexes = await models.MemberSubscription.listIndexes();
  const predecessor = indexes.find((index) => index.name === 'subscription_gym_predecessor');
  assert.deepEqual(predecessor.key, { gymId: 1, previousSubscriptionId: 1 }); assert.equal(predecessor.unique, undefined);
  assert.equal(models.Renewal, undefined); assert.equal(models.MemberSubscription.schema.path('amountPaise'), undefined);
});

test('trainer renewal history reads retain active assignment isolation', async () => {
  const adminToken = await login(); const first = await create(adminToken); const second = await renew(adminToken, first);
  const unrelated = await create(adminToken, { memberId: String(memberOther._id) });
  const otherRenewal = await renew(adminToken, unrelated); const token = await login(trainer);
  const result = await send('get', path(), token);
  assert.equal(result.status, 200); assert.equal(result.body.meta.pagination.total, 2);
  assert.equal((await send('get', `${path()}/${second.id}`, token)).body.data.previousSubscriptionId, first.id);
  error(await send('get', `${path()}/${otherRenewal.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  error(await send('get', `${path()}/${second.id}`, token), 404, 'SUBSCRIPTION_NOT_FOUND');
});

test('unsafe raw commercial and lifecycle state cannot authorize a renewal', async () => {
  const token = await login(); const first = await create(token);
  await models.MembershipPlan.collection.updateOne({ _id: planA._id }, { $set: { price: 1.5 } });
  error(await send('post', renewalPath(first), token, {}), 400, 'VALIDATION_ERROR');
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.id) }, { $set: { status: 'unknown' } });
  error(await send('post', renewalPath(first), token, {}), 500, 'INTERNAL_SERVER_ERROR');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.equal((await models.MemberSubscription.findById(first.id)).__v, 0);
});

test('missing predecessor during the serialization write aborts renewal and rolls back the member lock', async (t) => {
  const token = await login(); const first = await create(token);
  const profile = await models.MemberProfile.findById(memberA._id).lean();
  t.mock.method(models.MemberSubscription, 'findOneAndUpdate', async () => null);
  error(await send('post', renewalPath(first), token, {}), 404, 'SUBSCRIPTION_NOT_FOUND');
  assert.equal(await models.MemberSubscription.countDocuments(), 1);
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), profile);
});
