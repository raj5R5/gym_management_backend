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
const { createMemberSummaryService } = require('../../src/modules/memberSummary/summary.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, branchA, branchOther, branchB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/attendance`;
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
  const response = await send('post', subscriptionPath(gym), token, input(overrides));
  assert.equal(response.status, 201);
  return response.body.data;
}
function service() {
  return createMemberSummaryService({ ...models, authorizationService: createAuthorizationService(models) });
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
  branchOther = await models.Branch.create({ gymId: gymA._id, name: 'Other', nameKey: 'other', address });
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

const checkInInput = (overrides = {}) => ({ memberId: String(memberA._id), branchId: String(branchA._id), ...overrides });
async function visit(token, overrides = {}, gym = gymA) {
  const response = await send('post', `${path(gym)}/check-in`, token, checkInInput(overrides));
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
const out = (data, gym = gymA) => `${path(gym)}/${data.id}/check-out`;


const summaryPath = (profile = memberA, gym = gymA) => `/api/v1/gyms/${gym._id}/members/${profile._id}/summary`;
async function summary(token, profile = memberA, gym = gymA, suffix = '') {
  const response = await send('get', summaryPath(profile, gym) + suffix, token);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
}
async function payment(token, subscription, amountPaise, overrides = {}) {
  const response = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token, {
    memberId: subscription.memberId, subscriptionId: subscription.id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date().toISOString(), ...overrides });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}

test('admin receives a complete empty operational summary without a new collection or writes', async () => {
  const token = await login(); const before = await models.MemberProfile.findById(memberA._id).lean();
  const collections = (await database.connection.db.listCollections().toArray()).map((item) => item.name).sort();
  const data = await summary(token);
  assert.equal(data.member.id, String(memberA._id)); assert.equal(data.member.memberCode, 'ME01');
  assert.equal(data.currentBranch.id, String(branchA._id)); assert.equal(data.currentTrainers[0].trainerId, String(trainerA._id));
  assert.equal(data.currentSubscription, null); assert.equal(data.currentSubscriptionPaymentSummary, null);
  assert.deepEqual(data.subscriptionHistory, { items: [], total: 0, page: 1, limit: 20 });
  assert.deepEqual(data.paymentSummary, { totalSuccessfulAmountPaise: 0, successfulPaymentCount: 0, latestSuccessfulPayment: null });
  assert.deepEqual(data.attendanceSummary, { totalCompletedVisits: 0, latestAttendance: null, currentlyCheckedIn: false, currentAttendance: null });
  assert.deepEqual(await models.MemberProfile.findById(memberA._id).lean(), before);
  assert.deepEqual((await database.connection.db.listCollections().toArray()).map((item) => item.name).sort(), collections);
  assert.equal((await send('get', summaryPath(), token)).headers['cache-control'], 'no-store');
});

test('authentication, member role and unknown IDs deny summary access', async () => {
  error(await send('get', summaryPath()), 401, 'INVALID_AUTHENTICATION');
  error(await send('get', summaryPath(), await login(member)), 403, 'FORBIDDEN');
  error(await send('get', summaryPath({ _id: missingId() }), await login()), 404, 'MEMBER_NOT_FOUND');
});

test('trainer reads only currently assigned members and assignment deactivation revokes summary', async () => {
  const token = await login(trainer); assert.equal((await summary(token)).member.id, String(memberA._id));
  error(await send('get', summaryPath(memberOther), token), 404, 'MEMBER_NOT_FOUND');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  error(await send('get', summaryPath(), token), 404, 'MEMBER_NOT_FOUND');
});

test('cross-gym IDOR fails for both single-gym and multi-gym admins', async () => {
  const token = await login(); error(await send('get', summaryPath(memberB), token), 404, 'MEMBER_NOT_FOUND');
  error(await send('get', summaryPath(memberA, gymB), token), 403, 'FORBIDDEN');
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  error(await send('get', summaryPath(memberA, gymB), token), 404, 'MEMBER_NOT_FOUND');
  assert.equal((await summary(token, memberB, gymB)).member.id, String(memberB._id));
  const trainerToken = await login(trainer);
  error(await send('get', summaryPath(memberB), trainerToken), 404, 'MEMBER_NOT_FOUND');
});

test('inactive gyms/grants and inactive accounts remain denied', async () => {
  const token = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } });
    error(await send('get', summaryPath(), token), 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } });
  error(await send('get', summaryPath(), token), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'active' } });
  await models.UserAccount.updateOne({ _id: admin._id }, { $set: { status: 'suspended' } });
  error(await send('get', summaryPath(), token), 401, 'INVALID_AUTHENTICATION');
});

test('inactive/unlinked/ambiguous trainer profiles never gain summary access', async () => {
  const token = await login(trainer);
  for (const status of ['inactive', 'suspended']) {
    await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status } });
    error(await send('get', summaryPath(), token), 403, 'FORBIDDEN');
  }
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'active' } });
  await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', userId: trainer._id, firstName: 'Other', lastName: 'Trainer', phone: '9876543211' });
  error(await send('get', summaryPath(), token), 403, 'FORBIDDEN');
  await models.TrainerProfile.collection.updateMany({ userId: trainer._id }, { $unset: { userId: '' } });
  error(await send('get', summaryPath(), token), 403, 'FORBIDDEN');
});

test('profile fields are explicit and credentials injected into raw documents never appear', async () => {
  const token = await login(); const marker = 'private-credential-marker';
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: admin._id, passwordHash: marker,
    refreshToken: marker, securityEvents: [marker], address: { line1: 'Road', city: 'Pune', countryCode: 'IN', passwordHash: marker },
    emergencyContact: { name: 'Contact', phone: '9876543210', passwordHash: marker }, dateOfBirth: new Date('2000-01-01'), gender: 'male' } });
  await models.TrainerProfile.collection.updateOne({ _id: trainerA._id }, { $set: { passwordHash: marker, accessToken: marker } });
  await models.Branch.collection.updateOne({ _id: branchA._id }, { $set: { passwordHash: marker,
    contact: { email: 'branch@example.com', passwordHash: marker } } });
  const data = await summary(token); const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(marker), false);
  for (const field of ['userId', '__v', 'passwordHash', 'refreshToken', 'securityEvents']) assert.equal(field in data.member, false);
  assert.equal(data.member.dateOfBirth, '2000-01-01'); assert.equal(data.member.gender, 'male');
  assert.deepEqual(data.member.emergencyContact, { name: 'Contact', phone: '9876543210' });
  assert.deepEqual(data.currentBranch.contact, { email: 'branch@example.com' });
});

test('current branch can be inactive, absent or deleted without exposing another gym branch', async () => {
  const token = await login(); await models.Branch.updateOne({ _id: branchA._id }, { $set: { status: 'inactive' } });
  assert.equal((await summary(token)).currentBranch.status, 'inactive');
  await models.Branch.deleteOne({ _id: branchA._id }); assert.equal((await summary(token)).currentBranch, null);
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $unset: { branchId: '' } });
  assert.equal((await summary(token)).currentBranch, null);
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { branchId: branchB._id } });
  assert.equal((await summary(token)).currentBranch, null);
});

test('all valid active trainer assignments appear while inactive/foreign profiles and assignments do not', async () => {
  const token = await login();
  const other = await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', firstName: 'Second', lastName: 'Trainer', phone: '9876543211', specializations: ['Strength'] });
  await models.TrainerMemberAssignment.create({ gymId: gymA._id, memberId: memberA._id, trainerId: other._id });
  const data = await summary(token); assert.equal(data.currentTrainers.length, 2);
  assert.deepEqual(data.currentTrainers.find((item) => item.trainerId === String(other._id)).specializations, ['Strength']);
  await models.TrainerProfile.updateOne({ _id: other._id }, { $set: { status: 'inactive' } });
  assert.equal((await summary(token)).currentTrainers.length, 1);
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  assert.deepEqual((await summary(token)).currentTrainers, []);
});

test('current subscription is selected by UTC period rather than creation recency', async () => {
  const token = await login(); const older = await create(token, { startDate: day(-30) }); const current = await create(token);
  const renewed = { body: { data: await legacySuccessor(current) } };
  const data = await summary(token); assert.equal(data.currentSubscription.id, current.id);
  assert.equal(data.currentSubscription.isCurrentlyActive, true); assert.equal(data.subscriptionHistory.total, 3);
  assert.deepEqual(data.subscriptionHistory.items.map((item) => item.id), [renewed.body.data.id, current.id, older.id]);
  assert.equal(data.subscriptionHistory.items[0].isCurrentlyActive, false); assert.equal(data.subscriptionHistory.items[2].status, 'expired');
  assert.equal(data.subscriptionHistory.items[0].previousSubscriptionId, current.id);
});

test('expired, cancelled and future-only subscriptions never become current', async () => {
  const token = await login(); const expired = await create(token, { startDate: day(-30) });
  assert.equal((await summary(token)).currentSubscription, null); assert.equal(expired.endDate, day());
  const current = await create(token);
  await legacySuccessor(current);
  await send('patch', `${subscriptionPath()}/${current.id}/cancel`, token, {});
  const data = await summary(token); assert.equal(data.currentSubscription, null); assert.equal(data.currentSubscriptionPaymentSummary, null);
  assert.equal(data.subscriptionHistory.total, 3);
});

test('plan edits/deactivation never replace snapshot price/duration or cancel the current summary', async () => {
  const token = await login(); const current = await create(token);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { name: 'Changed', normalizedName: 'changed', durationDays: 365, price: 180000, status: 'inactive' } });
  const data = await summary(token); assert.equal(data.currentSubscription.id, current.id);
  assert.equal(data.currentSubscription.pricePaiseSnapshot, 150000); assert.equal(data.currentSubscription.durationDaysSnapshot, 30);
  assert.equal(data.currentSubscription.planNameSnapshot, 'Monthly'); assert.equal(data.currentSubscriptionPaymentSummary.pricePaise, 150000);
});

test('ambiguous current periods and invalid raw snapshots fail without partial responses', async () => {
  const token = await login(); const current = await create(token); const copy = await models.MemberSubscription.findById(current.id).lean(); delete copy._id;
  const duplicate = await models.MemberSubscription.create(copy);
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
  await models.MemberSubscription.deleteOne({ _id: duplicate._id });
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(current.id) }, { $set: { pricePaiseSnapshot: 1.5 } });
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
});

test('bounded deterministic subscription history does not recursively traverse renewal chains', async () => {
  const token = await login(); const first = await create(token); const second = { body: { data: await legacySuccessor(first) } };
  await legacySuccessor(second.body.data);
  const data = await summary(token, memberA, gymA, '?page=2&limit=1');
  assert.equal(data.currentSubscription.id, first.id); assert.equal(data.subscriptionHistory.items.length, 1);
  assert.equal(data.subscriptionHistory.items[0].id, second.body.data.id); assert.equal(data.subscriptionHistory.total, 3);
  assert.deepEqual(Object.keys(data.subscriptionHistory).sort(), ['items', 'limit', 'page', 'total']);
  assert.equal('previous' in data.subscriptionHistory.items[0], false);
});

test('successful payments aggregate exact integer paise and balance uses the subscription snapshot', async () => {
  const token = await login(); const old = await create(token, { startDate: day(-30) }); const current = await create(token);
  await payment(token, old, 50001, { paidAt: new Date(Date.now() - 10000).toISOString() });
  await payment(token, current, 60001, { paidAt: new Date(Date.now() - 5000).toISOString() });
  const latest = await payment(token, current, 89999);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { price: 190000 } });
  const data = await summary(token); assert.equal(data.paymentSummary.totalSuccessfulAmountPaise, 200001);
  assert.equal(data.paymentSummary.successfulPaymentCount, 3); assert.equal(data.paymentSummary.latestSuccessfulPayment.id, latest.id);
  assert.deepEqual(data.currentSubscriptionPaymentSummary, { pricePaise: 150000, paidAmountPaise: 150000, remainingAmountPaise: 0, paymentCount: 2 });
});

test('pending, failed and cancelled payments never contribute to successful totals or latest', async () => {
  const token = await login(); const current = await create(token); const success = await payment(token, current, 50000);
  for (const status of ['pending', 'failed', 'cancelled']) await models.Payment.create({ gymId: gymA._id, memberId: memberA._id,
    subscriptionId: current.id, amountPaise: 100000, paymentMethod: 'cash', paidAt: new Date(), status });
  const data = await summary(token); assert.equal(data.paymentSummary.totalSuccessfulAmountPaise, 50000);
  assert.equal(data.paymentSummary.successfulPaymentCount, 1); assert.equal(data.paymentSummary.latestSuccessfulPayment.id, success.id);
  assert.equal(data.currentSubscriptionPaymentSummary.remainingAmountPaise, 100000);
});

test('negative balances and fractional/invalid stored payment amounts fail safely', async () => {
  const token = await login(); const current = await create(token); const paid = await payment(token, current, 150000);
  const id = new mongoose.Types.ObjectId(paid.id);
  for (const amountPaise of [150001, -1, 0.5, '100', 0]) {
    await models.Payment.collection.updateOne({ _id: id }, { $set: { amountPaise } });
    error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
  }
});

test('payment and subscription foreign references fail closed rather than leak financial data', async () => {
  const token = await login(); const current = await create(token); const paid = await payment(token, current, 1);
  const other = await create(token, { memberId: String(memberOther._id) });
  await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: { subscriptionId: new mongoose.Types.ObjectId(other.id) } });
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
  await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: { subscriptionId: new mongoose.Types.ObjectId(current.id) } });
  await models.MemberSubscription.collection.updateOne({ _id: new mongoose.Types.ObjectId(current.id) }, { $set: { membershipPlanId: planB._id } });
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
});

test('attendance summary counts completed visits and exposes the latest and current open visit', async () => {
  const token = await login(); await create(token); const first = await visit(token); await send('post', out(first), token, {});
  const second = await visit(token); const data = await summary(token);
  assert.equal(data.attendanceSummary.totalCompletedVisits, 1); assert.equal(data.attendanceSummary.currentlyCheckedIn, true);
  assert.equal(data.attendanceSummary.latestAttendance.id, second.id); assert.equal(data.attendanceSummary.currentAttendance.id, second.id);
  assert.equal(data.attendanceSummary.currentAttendance.status, 'open');
  await send('post', out(second), token, {}); const completed = await summary(token);
  assert.equal(completed.attendanceSummary.totalCompletedVisits, 2); assert.equal(completed.attendanceSummary.currentlyCheckedIn, false);
  assert.equal(completed.attendanceSummary.currentAttendance, null);
});

test('member branch transfer changes current branch but preserves historical attendance branch', async () => {
  const token = await login(); await create(token); const data = await visit(token); await send('post', out(data), token, {});
  await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { branchId: branchOther._id } });
  const result = await summary(token); assert.equal(result.currentBranch.id, String(branchOther._id));
  assert.equal(result.attendanceSummary.latestAttendance.branchId, String(branchA._id));
});

test('unrelated member/gym payments, subscriptions and attendance cannot contribute to a summary', async () => {
  const token = await login(); await create(token); const current = await create(token, { memberId: String(memberOther._id) });
  await payment(token, current, 150000); const visitOther = await visit(token, { memberId: String(memberOther._id) });
  await send('post', out(visitOther), token, {});
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  await create(token, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  await visit(token, { memberId: String(memberB._id), branchId: String(branchB._id) }, gymB);
  const data = await summary(token); assert.equal(data.subscriptionHistory.total, 1);
  assert.equal(data.paymentSummary.successfulPaymentCount, 0); assert.equal(data.attendanceSummary.totalCompletedVisits, 0);
  assert.equal(data.attendanceSummary.latestAttendance, null);
});

test('invalid IDs, pagination, unknown parameters, operators and client clocks are rejected', async () => {
  const token = await login();
  for (const query of ['page=0', 'page=1.5', 'page=10001', 'limit=101', 'limit=0', 'role=admin', 'gymId=x', 'memberId=x',
    'userId=x', 'now=2026-10-07', 'currentDate=2026-10-07', '$where=true', 'limit[$ne]=1', 'page=1&page=2'])
    error(await send('get', `${summaryPath()}?${query}`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', summaryPath({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', summaryPath(memberA, { _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  const trainerToken = await login(trainer);
  error(await send('get', `${summaryPath(memberOther)}?memberId=${memberA._id}`, trainerToken), 400, 'VALIDATION_ERROR');
});

test('related lookup failures return one safe error rather than partial operational data', async (t) => {
  const token = await login(); await create(token);
  for (const [model, method] of [[models.Branch, 'findOne'], [models.MemberSubscription, 'aggregate'], [models.Payment, 'aggregate'],
    [models.Attendance, 'aggregate'], [models.TrainerMemberAssignment, 'aggregate'], [models.MemberProfile, 'findOne']]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private database credentials'); });
    const response = await send('get', summaryPath(), token); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal('data' in response.body, false); assert.equal(JSON.stringify(response.body).includes('private'), false); mocked.mock.restore();
  }
});

test('summary services reject incomplete/stale authorization contexts', async () => {
  const token = await login(); await summary(token); const { auth, authorization } = await context();
  await assert.rejects(service().get(auth, undefined, String(memberA._id), { page: 1, limit: 20 }), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  await assert.rejects(service().get(auth, authorization, String(memberA._id), { page: 1, limit: 20 }), { code: 'FORBIDDEN' });
});

test('summary performs no domain writes or session/transaction creation', async (t) => {
  const token = await login(); const current = await create(token); await payment(token, current, 1); await visit(token);
  const snapshots = await Promise.all([models.MemberProfile, models.TrainerProfile, models.TrainerMemberAssignment, models.MemberSubscription, models.Payment, models.Attendance]
    .map((model) => model.find({}).lean()));
  t.mock.method(database.connection, 'startSession', () => { throw new Error('Read must not create transaction'); });
  for (const model of [models.MemberProfile, models.MemberSubscription, models.Payment, models.Attendance])
    for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate']) t.mock.method(model, method, () => { throw new Error('Read attempted a write'); });
  await summary(token);
  const after = await Promise.all([models.MemberProfile, models.TrainerProfile, models.TrainerMemberAssignment, models.MemberSubscription, models.Payment, models.Attendance]
    .map((model) => model.find({}).lean()));
  assert.deepEqual(after, snapshots);
});

test('summary uses a fixed number of aggregates as history grows and returns at most the requested page', async (t) => {
  const token = await login(); const first = await create(token); let previous = first;
  for (let i = 0; i < 4; i += 1) { previous = await legacySuccessor(previous); }
  const mocks = [models.MemberSubscription, models.Payment, models.Attendance, models.TrainerMemberAssignment]
    .map((model) => t.mock.method(model, 'aggregate'));
  const data = await summary(token, memberA, gymA, '?limit=2'); assert.equal(data.subscriptionHistory.items.length, 2); assert.equal(data.subscriptionHistory.total, 5);
  for (const mocked of mocks) assert.equal(mocked.mock.callCount(), 1);
});

test('summary remains protected on bootstrap and no write or alternate summary endpoint exists', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).get(summaryPath()), 401, 'INVALID_AUTHENTICATION');
  const token = await login();
  for (const method of ['post', 'patch', 'delete']) error(await send(method, summaryPath(), token, {}), 404, 'NOT_FOUND');
  error(await send('get', '/api/v1/member-summary', token), 404, 'NOT_FOUND');
});

test('oversized exact monetary totals fail instead of rounding a JSON number', async (t) => {
  const token = await login();
  t.mock.method(models.Payment, 'aggregate', async () => [{ invalid: [],
    total: [{ amount: mongoose.Types.Decimal128.fromString('9007199254740992'), count: 1 }], latest: [], current: [] }]);
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
});

test('foreign trainer references are excluded and branch references never leak foreign IDs', async () => {
  const token = await login();
  const foreign = await models.TrainerProfile.create({ gymId: gymB._id, trainerCode: 'TR01', firstName: 'Foreign', lastName: 'Trainer', phone: '9876543211' });
  await models.TrainerMemberAssignment.create({ gymId: gymA._id, memberId: memberA._id, trainerId: foreign._id });
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { branchId: branchB._id } });
  const data = await summary(token); assert.equal(data.currentTrainers.length, 1);
  assert.equal(data.currentBranch, null); assert.equal(data.member.branchId, null);
  assert.equal(JSON.stringify(data).includes(String(foreign._id)), false);
  assert.equal(JSON.stringify(data).includes(String(branchB._id)), false);
});

test('corrupt attendance links and ambiguous open states fail closed', async () => {
  const token = await login(); await create(token); const data = await visit(token);
  await models.Attendance.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { branchId: branchB._id } });
  error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
  await models.Attendance.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { branchId: branchA._id } });
  await models.Attendance.collection.dropIndex('attendance_open_member_unique');
  try {
    const copy = await models.Attendance.findById(data.id).lean(); delete copy._id;
    const duplicate = await models.Attendance.create(copy);
    error(await send('get', summaryPath(), token), 500, 'INTERNAL_SERVER_ERROR');
    await models.Attendance.deleteOne({ _id: duplicate._id });
  } finally { await models.Attendance.createIndexes(); }
});

test('trainer authorization lookup failures deny summary without returning profile information', async (t) => {
  const token = await login(trainer);
  for (const [model, method] of [[models.TrainerProfile, 'find'], [models.TrainerMemberAssignment, 'exists']]) {
    const mocked = t.mock.method(model, method, () => { throw new Error('private security details'); });
    const response = await send('get', summaryPath(), token); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal('data' in response.body, false); assert.equal(JSON.stringify(response.body).includes('private'), false); mocked.mock.restore();
  }
});

// Seed pre-Task-9 scheduled history only in the isolated test database. Existing
// production records remain readable; new early renewal API writes are blocked.
async function legacySuccessor(subscription) {
  const source = await models.MemberSubscription.findById(subscription.id).lean();
  const startDate = new Date(source.endDate); const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + source.durationDaysSnapshot);
  const fields = { ...source };
  delete fields._id; delete fields.__v; delete fields.createdAt; delete fields.updatedAt;
  const record = await models.MemberSubscription.create({ ...fields, previousSubscriptionId: source._id, startDate, endDate, status: 'active' });
  return { id: String(record._id), startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10), isCurrentlyActive: false };
}
