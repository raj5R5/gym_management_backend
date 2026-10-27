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
const { createApp: createRuntimeApp, createBootstrapApp } = require('../../src/app');
const { historicalRecords } = require('../helpers/historicalRecords');
const createApp = (options) => { const app = createRuntimeApp(options); historicalRecords(options.database?.connection); return app; };
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createMemberSummaryService } = require('../../src/modules/memberSummary/summary.service');
const { createSelfMemberResolver } = require('../../src/modules/memberSelfService/self.authorization');
const { createMemberSelfService } = require('../../src/modules/memberSelfService/self.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, branchA, branchOther, branchB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const subscriptionPath = (gym = gymA) => `/api/v1/gyms/${gym._id}/subscriptions`;
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
  const authorizationService = createAuthorizationService(models);
  return createMemberSelfService({ summaryService: createMemberSummaryService({ ...models, authorizationService, resolveSelfMember: createSelfMemberResolver({ ...models, authorizationService }) }) });
}
async function context() {
  const auth = { user: member, session: await models.AuthSession.findOne({ userId: member._id }).lean() };
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
  memberA = await models.MemberProfile.create({ ...person, userId: member._id, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME01' });
  memberOther = await models.MemberProfile.create({ ...person, gymId: gymA._id, branchId: branchA._id, memberCode: 'ME02' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, branchId: branchB._id, memberCode: 'ME01' });
  trainerA = await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  assignment = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberA._id });
  const plan = { name: 'Monthly', durationDays: 30, price: 150000 };
  planA = await models.MembershipPlan.create({ ...plan, gymId: gymA._id });
  planB = await models.MembershipPlan.create({ ...plan, gymId: gymB._id });
});

async function visit(_token, overrides = {}, gym = gymA) {
  const subscription = await models.MemberSubscription.findOne({ gymId: gym._id, memberId: memberA._id }).lean();
  const record = await models.Attendance.create({ gymId: gym._id, memberId: memberA._id, branchId: branchA._id,
    subscriptionId: subscription?._id ?? new mongoose.Types.ObjectId(), recordedByUserId: admin._id,
    checkInAt: new Date(), status: 'open', ...overrides });
  return { id: String(record._id) };
}


async function payment(token, subscription, amountPaise, overrides = {}) {
  const response = await send('post', `/api/v1/gyms/${gymA._id}/payments`, token, {
    memberId: subscription.memberId, subscriptionId: subscription.id, amountPaise,
    paymentMethod: 'cash', paidAt: new Date().toISOString(), ...overrides });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}

const kinds = ['profile', 'membership', 'payments', 'trainers'];
const selfPath = (kind, gym = gymA) => `/api/v1/me/gyms/${gym._id}/${kind}`;
async function read(kind, token, query = '', gym = gymA) {
  const response = await send('get', selfPath(kind, gym)+query, token); assert.equal(response.status, 200, JSON.stringify(response.body.error));
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.body.meta.requestId, response.headers['x-request-id']); return response.body;
}
test('active linked member can read all four remaining self-service endpoints using existing envelopes', async () => {
  const token = await login(member); const profile = await read('profile', token);
  assert.equal(profile.data.member.id, String(memberA._id)); assert.equal(profile.data.member.memberCode, 'ME01');
  assert.equal(profile.data.currentBranch, undefined);
  const membership = await read('membership', token); assert.deepEqual(membership.data, { currentMembership: null, subscriptions: [] });
  assert.deepEqual(membership.meta.pagination, { page: 1, limit: 20, total: 0 });
  const payments = await read('payments', token); assert.deepEqual(payments.data, { payments: [], totalSuccessfulPaidPaise: 0 });
  error(await send('get', selfPath('attendance'), token), 404, 'NOT_FOUND');
  assert.equal((await read('trainers', token)).data[0].trainerId, String(trainerA._id));
});
test('provisioned and activated member logs in and resolves the newly linked self identity', async () => {
  const adminToken = await login(); const provisioned = await send('post', `/api/v1/gyms/${gymA._id}/members/${memberOther._id}/account`, adminToken, { email: 'portal@example.com' });
  assert.equal(provisioned.status, 201);
  assert.equal((await send('post', '/api/v1/account/activate', undefined, { token: provisioned.body.data.activationToken, password })).status, 200);
  const user = await models.UserAccount.findById(provisioned.body.data.userId); const token = await login(user);
  assert.equal((await read('profile', token)).data.member.id, String(memberOther._id));
  assert.deepEqual((await read('trainers', token)).data, []);
});
test('admin/trainer roles and anonymous clients cannot use member endpoints', async () => {
  for (const account of [admin, trainer]) {
    const token = await login(account);
    for (const kind of kinds) { error(await send('get', selfPath(kind), token), 403, 'FORBIDDEN'); error(await send('get', selfPath(kind)), 401, 'INVALID_AUTHENTICATION'); }
  }
});
for (const status of ['inactive', 'suspended']) test(`${status} profile denies every self read without reactivation`, async () => {
  const token = await login(member); await models.MemberProfile.updateOne({ _id: memberA._id }, { status });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 403, 'FORBIDDEN');
  assert.equal((await models.MemberProfile.findById(memberA._id)).status, status);
});
for (const status of ['inactive', 'suspended']) test(`${status} GymAccess denies every self read`, async () => {
  const token = await login(member); await models.GymAccess.updateOne({ userId: member._id, gymId: gymA._id }, { status });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 403, 'FORBIDDEN');
});
test('inactive gym and revoked account/session deny all member reads', async () => {
  const token = await login(member); await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'active' });
  await models.UserAccount.updateOne({ _id: member._id }, { status: 'suspended' });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 401, 'INVALID_AUTHENTICATION');
  await models.UserAccount.updateOne({ _id: member._id }, { status: 'active' });
  await models.AuthSession.updateMany({ userId: member._id }, { status: 'revoked' });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 401, 'INVALID_AUTHENTICATION');
});
for (const condition of ['missing', 'null', 'mismatched', 'ambiguous', 'inactive duplicate']) test(`${condition} member identity link fails closed for all reads`, async () => {
  const token = await login(member);
  if (condition === 'missing') await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $unset: { userId: '' } });
  else if (condition === 'null') await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: null } });
  else if (condition === 'mismatched') await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: admin._id } });
  else await models.MemberProfile.collection.updateOne({ _id: memberOther._id }, { $set: { userId: member._id, ...(condition === 'inactive duplicate' ? { status: 'inactive' } : {}) } });
  for (const kind of kinds) error(await send('get', selfPath(kind), token), 403, 'FORBIDDEN');
});
test('one global account resolves independent member profiles/data in two gyms and cannot access a third', async () => {
  await models.GymAccess.create({ userId: member._id, gymId: gymB._id, role: 'member', status: 'active' });
  await models.MemberProfile.collection.updateOne({ _id: memberB._id }, { $set: { userId: member._id } });
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const adminToken = await login(); const subA = await create(adminToken); const subB = await create(adminToken, { memberId: String(memberB._id), membershipPlanId: String(planB._id) }, gymB);
  await payment(adminToken, subA, 101);
  await models.Payment.create({ gymId: gymB._id, memberId: memberB._id, subscriptionId: subB.id, amountPaise: 202, status: 'succeeded', paymentMethod: 'cash', paidAt: new Date() });
  const visitA = await visit(adminToken); const visitB = await visit(adminToken, { memberId: String(memberB._id), branchId: String(branchB._id) }, gymB);
  const foreignTrainer = await models.TrainerProfile.create({ gymId: gymB._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543210' });
  await models.TrainerMemberAssignment.create({ gymId: gymB._id, trainerId: foreignTrainer._id, memberId: memberB._id });
  const token = await login(member);
  for (const [gym, person, sub, amount, attendanceId, trainerId] of [[gymA, memberA, subA, 101, visitA.id, trainerA._id], [gymB, memberB, subB, 202, visitB.id, foreignTrainer._id]]) {
    assert.equal((await read('profile', token, '', gym)).data.member.id, String(person._id));
    assert.deepEqual((await read('membership', token, '', gym)).data.subscriptions.map((row) => row.id), [sub.id]);
    assert.equal((await read('payments', token, '', gym)).data.totalSuccessfulPaidPaise, amount);
    error(await send('get', selfPath('attendance', gym), token), 404, 'NOT_FOUND');
    assert.ok(attendanceId); // historical fixture exists but has no active endpoint
    assert.deepEqual((await read('trainers', token, '', gym)).data.map((row) => row.trainerId), [String(trainerId)]);
  }
  const third = await models.Gym.create({ name: 'Gym C', nameKey: 'gym c', status: 'active' });
  for (const kind of kinds) error(await send('get', selfPath(kind, third), token), 403, 'FORBIDDEN');
});
test('another-gym staff access cannot impersonate a member even with a linked profile', async () => {
  const token = await login(member); await models.MemberProfile.collection.updateOne({ _id: memberB._id }, { $set: { userId: member._id } });
  for (const role of ['admin', 'trainer']) {
    await models.GymAccess.deleteOne({ userId: member._id, gymId: gymB._id }); await models.GymAccess.create({ userId: member._id, gymId: gymB._id, role, status: 'active' });
    for (const kind of kinds) error(await send('get', selfPath(kind, gymB), token), 403, 'FORBIDDEN');
  }
});
test('client IDs in body/query/path cannot choose identity, subscription, payment, visit or trainer', async () => {
  const token = await login(member);
  for (const kind of kinds) for (const field of ['memberId', 'userId', 'gymId', 'subscriptionId', 'paymentId', 'attendanceId', 'trainerId', 'role', 'status']) {
    error(await send('get', selfPath(kind)+'?'+field+'='+memberB._id, token), 400, 'VALIDATION_ERROR');
    error(await send('get', selfPath(kind), token, { [field]: String(memberB._id) }), 400, 'VALIDATION_ERROR');
    // Reset only the app-owned per-process API limiter between deliberate invalid attempts.
    app = createApp({ config, database });
  }
  for (const kind of kinds) error(await send('get', selfPath(kind)+'/'+memberOther._id, token), 404, 'NOT_FOUND');
  error(await send('get', selfPath('profile', { _id: 'bad' }), token), 400, 'VALIDATION_ERROR');
  for (const kind of kinds) error(await send('get', selfPath(kind, { _id: missingId() }), token), 403, 'FORBIDDEN');
});
test('profile DTO allows own personal information while stripping nested internal fields and foreign branch data', async () => {
  const address = { line1: 'Road', city: 'Pune', countryCode: 'IN', passwordHash: 'must-not-leak' };
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { address, emergencyContact: { name: 'Contact', phone: '9876543211', relationship: 'Parent', token: 'must-not-leak' }, dateOfBirth: new Date('2000-01-01T00:00:00Z') } });
  const token = await login(member); const result = await read('profile', token);
  assert.equal(result.data.member.dateOfBirth, '2000-01-01'); assert.equal(result.data.member.address.city, 'Pune'); assert.equal(result.data.member.emergencyContact.name, 'Contact');
  assert.doesNotMatch(JSON.stringify(result), /password|token|session|userId|gymAccess|must-not-leak|__v|"_id"/i);
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { branchId: branchB._id } });
  const foreign = await read('profile', token); assert.equal(foreign.data.member.branchId, undefined); assert.equal(foreign.data.currentBranch, undefined);
});
test('membership uses immutable snapshots and exclusive UTC boundaries across past, current, future and cancelled periods', async () => {
  const adminToken = await login(); const cancelled = await create(adminToken, { startDate: day(-90) });
  assert.equal((await send('patch', `${subscriptionPath()}/${cancelled.id}/cancel`, adminToken, {})).status, 200);
  const expired = await create(adminToken, { startDate: day(-30) }); const current = await create(adminToken);
  const future = await legacySuccessor(current);
  await models.MembershipPlan.updateOne({ _id: planA._id }, { status: 'inactive', name: 'Changed', durationDays: 60, price: 300000 });
  const token = await login(member); const result = await read('membership', token);
  assert.equal(result.data.currentMembership.id, current.id); assert.equal(result.data.currentMembership.planNameSnapshot, 'Monthly'); assert.equal(result.data.currentMembership.pricePaiseSnapshot, 150000);
  assert.deepEqual(result.data.subscriptions.map((row) => row.id), [future.id, current.id, expired.id, cancelled.id]);
  assert.equal(result.data.subscriptions[0].isCurrentlyActive, false); assert.equal(result.data.subscriptions[2].status, 'expired'); assert.equal(result.data.subscriptions[3].status, 'cancelled');
  assert.equal((await send('patch', `${subscriptionPath()}/${current.id}/cancel`, adminToken, {})).status, 200);
  assert.equal((await read('membership', token)).data.currentMembership, null);
});
test('membership ambiguity fails closed even on a page that hides effective periods', async () => {
  const sub = await create(await login()); const raw = await models.MemberSubscription.findById(sub.id).lean(); delete raw._id; await models.MemberSubscription.create(raw);
  error(await send('get', selfPath('membership')+'?page=10000&limit=1', await login(member)), 500, 'INTERNAL_SERVER_ERROR');
});
test('successful own payments use exact paise totals; other members and non-success states never count', async () => {
  const adminToken = await login(); const sub = await create(adminToken); const other = await create(adminToken, { memberId: String(memberOther._id) });
  await payment(adminToken, sub, 101); await payment(adminToken, sub, 202); await payment(adminToken, other, 999);
  for (const status of ['pending', 'failed', 'cancelled']) await models.Payment.create({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub.id, amountPaise: 999,
    paymentMethod: 'cash', paidAt: new Date(), status });
  const result = await read('payments', await login(member)); assert.equal(result.data.totalSuccessfulPaidPaise, 303);
  assert.equal(result.meta.pagination.total, 2); assert.deepEqual(result.data.payments.map((row) => row.amountPaise).sort((a,b) => a-b), [101, 202]);
  assert.doesNotMatch(JSON.stringify(result), /recordedBy|notes|userId|password|token|session/i);
});
test('corrupt foreign-subscription references or fractional payments fail closed without data leakage', async () => {
  const adminToken = await login(); const sub = await create(adminToken); const other = await create(adminToken, { memberId: String(memberOther._id) }); const paid = await payment(adminToken, sub, 101);
  const token = await login(member);
  for (const update of [{ subscriptionId: new mongoose.Types.ObjectId(other.id) }, { amountPaise: 1.5 }]) {
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: update });
    error(await send('get', selfPath('payments'), token), 500, 'INTERNAL_SERVER_ERROR');
    await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paid.id) }, { $set: { subscriptionId: new mongoose.Types.ObjectId(sub.id), amountPaise: 101 } });
  }
});

test('only active own assignments to active same-gym trainers are exposed with allowlisted DTOs', async () => {
  const adminToken = await login(); const other = await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543210', branchId: branchOther._id, specializations: ['Strength'] });
  const next = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: other._id, memberId: memberA._id });
  await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: trainerA._id, memberId: memberOther._id });
  const token = await login(member); const result = await read('trainers', token);
  assert.equal(result.data.length, 2); const row = result.data.find((value) => value.assignmentId === String(next._id));
  assert.deepEqual(Object.keys(row).sort(), ['trainerId','trainerCode','firstName','lastName','phone','specializations','assignmentId','assignedAt'].sort());
  await send('patch', `/api/v1/gyms/${gymA._id}/trainer-assignments/${assignment._id}/deactivate`, adminToken, {});
  assert.deepEqual((await read('trainers', token)).data.map((value) => value.assignmentId), [String(next._id)]);
  await models.TrainerProfile.updateOne({ _id: other._id }, { status: 'inactive' }); assert.deepEqual((await read('trainers', token)).data, []);
});
test('all collection pages have bounded defaults/maxima and strict pagination validation', async () => {
  const token = await login(member);
  for (const kind of kinds.filter((value) => value !== 'profile')) {
    const defaults = await read(kind, token); assert.equal(defaults.meta.pagination.page, 1); assert.equal(defaults.meta.pagination.limit, 20);
    assert.equal((await read(kind, token, '?page=10000&limit=100')).meta.pagination.limit, 100);
    for (const query of ['page=0','page=10001','page=1.5','limit=0','limit=101','page[$gt]=1','limit[]=1','page=1&page=2','from=bad']) {
      error(await send('get', selfPath(kind)+'?'+query, token), 400, 'VALIDATION_ERROR'); app = createApp({ config, database });
    }
  }
});
test('all history views remain bounded when the member has more than 100 records', async () => {
  const sub = await create(await login()); const raw = await models.MemberSubscription.findById(sub.id).lean(); delete raw._id;
  await models.MemberSubscription.insertMany(Array.from({ length: 105 }, () => ({ ...raw, status: 'cancelled', cancelledAt: new Date() })));
  await models.Payment.insertMany(Array.from({ length: 105 }, () => ({ gymId: gymA._id, memberId: memberA._id, subscriptionId: sub.id,
    amountPaise: 1, status: 'succeeded', paymentMethod: 'cash', paidAt: new Date() })));
  const when = new Date('2025-01-01T00:00:00Z');
  await models.Attendance.insertMany(Array.from({ length: 105 }, () => ({ gymId: gymA._id, memberId: memberA._id, branchId: branchA._id,
    subscriptionId: sub.id, recordedByUserId: admin._id, status: 'completed', checkInAt: when, checkOutAt: new Date(when.getTime()+1000) })));
  const trainers = await models.TrainerProfile.insertMany(Array.from({ length: 105 }, (_value, index) => ({ gymId: gymA._id,
    trainerCode: 'B'+index, firstName: 'Assigned', lastName: 'Trainer', phone: '9876543210' })));
  await models.TrainerMemberAssignment.insertMany(trainers.map((profile) => ({ gymId: gymA._id, memberId: memberA._id, trainerId: profile._id })));
  const token = await login(member);
  for (const kind of ['membership','payments','trainers']) {
    const rows = (response) => kind === 'membership' ? response.data.subscriptions : kind === 'payments' ? response.data.payments : response.data;
    assert.equal(rows(await read(kind, token)).length, 20);
    const max = await read(kind, token, '?limit=100'); assert.equal(rows(max).length, 100); assert.ok(max.meta.pagination.total > 100);
    if (kind === 'membership') assert.equal(max.data.currentMembership.id, sub.id);
    if (kind === 'payments') assert.equal(max.data.totalSuccessfulPaidPaise, 105);
  }
});
test('membership, payment, attendance and trainer ordering/pagination are deterministic with tied timestamps', async () => {
  const adminToken = await login(); const sub = await create(adminToken);
  const raw = await models.MemberSubscription.findById(sub.id).lean(); delete raw._id;
  const historical = await models.MemberSubscription.create({ ...raw, status: 'cancelled', cancelledAt: new Date() });
  const paymentOne = await payment(adminToken, sub, 101); const paymentTwo = await payment(adminToken, sub, 202);
  const fixed = new Date('2025-01-01T00:00:00Z'); await models.Payment.collection.updateMany({}, { $set: { paidAt: fixed } });
  await models.Attendance.create([0, 1].map(() => ({ gymId: gymA._id, memberId: memberA._id, branchId: branchA._id, subscriptionId: sub.id,
    status: 'completed', checkInAt: fixed, checkOutAt: new Date(fixed.getTime()+1000), recordedByUserId: admin._id })));
  const other = await models.TrainerProfile.create({ gymId: gymA._id, trainerCode: 'TR02', firstName: 'Other', lastName: 'Trainer', phone: '9876543210' });
  const assigned = await models.TrainerMemberAssignment.create({ gymId: gymA._id, trainerId: other._id, memberId: memberA._id });
  await models.TrainerMemberAssignment.collection.updateMany({}, { $set: { assignedAt: fixed } });
  const token = await login(member);
  for (const [kind, ids, field] of [['membership', [sub.id,String(historical._id)], 'id'], ['payments', [paymentOne.id,paymentTwo.id], 'id'],
    ['trainers', [String(assigned._id),String(assignment._id)], 'assignmentId']]) {
    const one = await read(kind, token, '?page=1&limit=1'); const two = await read(kind, token, '?page=2&limit=1');
    const rows = (response) => kind === 'membership' ? response.data.subscriptions : kind === 'payments' ? response.data.payments : response.data;
    assert.deepEqual([...rows(one),...rows(two)].map((value) => value[field]), ids.sort().reverse()); assert.equal(one.meta.pagination.total, 2);
    if (kind === 'membership') assert.equal(two.data.currentMembership.id, sub.id);
    if (kind === 'payments') assert.equal(two.data.totalSuccessfulPaidPaise, 303);
  }
});
test('database authorization/profile/domain failures fail safely with no partial private data', async (t) => {
  const token = await login(member);
  for (const [model, method, kind] of [[models.GymAccess,'findOne','profile'],[models.Gym,'findOne','profile'],[models.MemberProfile,'find','profile'],
    [models.MemberSubscription,'aggregate','membership'],[models.Payment,'aggregate','payments'],[models.TrainerMemberAssignment,'aggregate','trainers']]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private storage credentials'); });
    const response = await send('get', selfPath(kind), token); error(response, 500, 'INTERNAL_SERVER_ERROR'); assert.doesNotMatch(JSON.stringify(response.body), /private storage credentials/); mock.mock.restore();
  }
});
test('self-service reads never write and use fixed aggregation counts without N+1 queries', async (t) => {
  const adminToken = await login(); const sub = await create(adminToken); await payment(adminToken, sub, 101); await visit(adminToken); const token = await login(member);
  let calls = 0;
  for (const model of [models.MemberSubscription, models.Payment, models.TrainerMemberAssignment]) {
    const original = model.aggregate; t.mock.method(model, 'aggregate', function (...args) { calls++; return original.apply(this,args); });
  }
  for (const model of Object.values(models)) for (const method of ['create','updateOne','updateMany','findOneAndUpdate','deleteOne','deleteMany']) t.mock.method(model, method, () => { throw new Error('Unexpected write'); });
  for (const kind of kinds) await read(kind, token); assert.equal(calls, 3);
});
test('service rechecks missing/stale scope and fails closed without a configured resolver', async () => {
  await login(member); const { auth, authorization } = await context();
  await assert.rejects(service().read(auth, undefined, 'profile', {}), { code: 'FORBIDDEN' });
  await assert.rejects(createMemberSummaryService({ ...models }).selfRead(auth, authorization, 'profile', {}), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: member._id, gymId: gymA._id }, { status: 'inactive' });
  for (const kind of kinds) await assert.rejects(service().read(auth, authorization, kind, kind === 'profile' ? {} : { page: 1, limit: 20 }), { code: 'FORBIDDEN' });
});
test('members remain denied from staff workflows and no self-service writes or ID aliases exist', async () => {
  const token = await login(member);
  for (const url of [`/api/v1/gyms/${gymA._id}/members/${memberOther._id}`, `/api/v1/gyms/${gymA._id}/members/${memberA._id}/summary`,
    `/api/v1/gyms/${gymA._id}/members/${memberA._id}/memberships`, `/api/v1/gyms/${gymA._id}/members/${memberA._id}/account`, `/api/v1/gyms/${gymA._id}/trainer-assignments`]) error(await send('get', url, token), 403, 'FORBIDDEN');
  for (const kind of kinds) for (const method of ['post','patch','delete']) error(await send(method, selfPath(kind), token, {}), 404, 'NOT_FOUND');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database }); error(await request(bootstrap).get(selfPath('profile')), 401, 'INVALID_AUTHENTICATION');
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
