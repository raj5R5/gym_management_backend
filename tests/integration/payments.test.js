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
const { createPaymentService } = require('../../src/modules/payments/payment.service');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberOther, memberB, planA, planB, trainerA, assignment, subscriptionA, subscriptionOther, subscriptionB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/payments`;
const day = (offset = 0) => { const value = new Date(); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); };
const input = (overrides = {}) => ({ memberId: String(memberA._id), subscriptionId: String(subscriptionA._id), amountPaise: 50000, paymentMethod: 'cash', paidAt: new Date().toISOString(), ...overrides });
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
  return createPaymentService({ ...models, authorizationService: createAuthorizationService(models) });
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

test('admin records successful immutable integer-paise payment with server-derived recorder', async () => {
  const data = await create(await login(), { paymentMethod: 'upi', transactionReference: ' TXN123456 ', notes: ' Receipt ' });
  assert.equal(data.gymId, String(gymA._id)); assert.equal(data.memberId, String(memberA._id));
  assert.equal(data.subscriptionId, String(subscriptionA._id)); assert.equal(data.amountPaise, 50000);
  assert.equal(data.status, 'succeeded'); assert.equal(data.paymentMethod, 'upi'); assert.equal(data.transactionReference, 'TXN123456');
  assert.equal(data.recordedByUserId, String(admin._id)); assert.equal(data.notes, 'Receipt'); assert.ok(data.createdAt && data.updatedAt);
  assert.equal('passwordHash' in data, false); assert.equal('__v' in data, false);
  const original = await models.MemberSubscription.findById(subscriptionA._id);
  assert.equal(original.pricePaiseSnapshot, 150000); assert.equal(original.status, 'active');
  assert.equal(original.updatedAt.toISOString(), subscriptionA.updatedAt.toISOString());
});

test('all payment operations require authentication', async () => {
  for (const [verb, url, body] of [['post', path(), input()], ['get', path()], ['get', `${path()}/${missingId()}`]]) {
    error(await send(verb, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
  }
});

test('trainer/member cannot create and member cannot read payments', async () => {
  const data = await create(await login());
  for (const account of [trainer, member]) {
    const token = await login(account); error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    if (account === member) {
      error(await send('get', path(), token), 403, 'FORBIDDEN'); error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
    }
  }
});

test('inactive/suspended/removed access and inactive gyms deny payment operations', async () => {
  const token = await login(); const data = await create(token);
  async function denied() {
    error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
    error(await send('get', path(), token), 403, 'FORBIDDEN'); error(await send('get', `${path()}/${data.id}`, token), 403, 'FORBIDDEN');
  }
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status } }); await denied();
  }
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'active' } });
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'inactive' } }); await denied();
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { status: 'active' } });
  await models.GymAccess.deleteMany({ userId: admin._id }); await denied();
});

test('missing/foreign subscriptions and member/subscription mismatch never create payments', async () => {
  const token = await login();
  for (const subscriptionId of [missingId(), String(subscriptionB._id)]) error(await send('post', path(), token, input({ subscriptionId })), 404, 'SUBSCRIPTION_NOT_FOUND');
  for (const memberId of [missingId(), String(memberB._id), String(memberOther._id)]) error(await send('post', path(), token, input({ memberId })), 400, 'PAYMENT_MEMBER_MISMATCH');
  error(await send('post', path(gymB), token, input()), 403, 'FORBIDDEN');
  error(await send('get', path({ _id: missingId() }), token), 403, 'FORBIDDEN');
  assert.equal(await models.Payment.countDocuments(), 0); assert.equal((await models.MemberSubscription.findById(subscriptionA._id)).__v, 0);
});

test('a missing referenced member fails safely even when the subscription exists', async () => {
  const token = await login(); await models.MemberProfile.deleteOne({ _id: memberA._id });
  error(await send('post', path(), token, input()), 404, 'MEMBER_NOT_FOUND'); assert.equal(await models.Payment.countDocuments(), 0);
});

test('partial and exact final payments are allowed but overpayment and zero-price payment are rejected', async () => {
  const token = await login();
  await create(token); await create(token); await create(token);
  error(await send('post', path(), token, input({ amountPaise: 1 })), 409, 'PAYMENT_OVERPAYMENT');
  assert.equal(await models.Payment.countDocuments(), 3);
  await models.MemberSubscription.collection.updateOne({ _id: subscriptionOther._id }, { $set: { pricePaiseSnapshot: 0 } });
  error(await send('post', path(), token, input({ memberId: String(memberOther._id), subscriptionId: String(subscriptionOther._id), amountPaise: 1 })), 409, 'PAYMENT_OVERPAYMENT');
});

test('pending, failed and cancelled records do not count toward collected totals', async () => {
  const token = await login();
  for (const status of ['pending', 'failed', 'cancelled']) {
    await models.Payment.create({ ...input(), gymId: gymA._id, status, amountPaise: 150000 });
  }
  const data = await create(token, { amountPaise: 150000 }); assert.equal(data.status, 'succeeded');
  error(await send('post', path(), token, input({ amountPaise: 1 })), 409, 'PAYMENT_OVERPAYMENT');
});

test('concurrent creation across independent app instances cannot overrun subscription total', async () => {
  const token = await login(); const second = createApp({ config, database });
  const results = await Promise.all([send('post', path(), token, input({ amountPaise: 100000 })),
    request(second).post(path()).set('Authorization', `Bearer ${token}`).send(input({ amountPaise: 100000 }))]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'PAYMENT_OVERPAYMENT');
  assert.equal((await models.Payment.find({ status: 'succeeded' })).reduce((sum, value) => sum + value.amountPaise, 0), 100000);
  await create(token, { amountPaise: 50000 });
});

test('subscription price snapshots control totals after plan edits; expired subscriptions can collect arrears', async () => {
  const token = await login();
  await models.MembershipPlan.updateOne({ _id: planA._id }, { $set: { price: 180000, status: 'inactive' } });
  const data = await create(token, { amountPaise: 150000 }); assert.equal(data.amountPaise, 150000);
  error(await send('post', path(), token, input({ amountPaise: 1 })), 409, 'PAYMENT_OVERPAYMENT');
  await models.MemberSubscription.collection.updateOne({ _id: subscriptionOther._id }, { $set: { status: 'expired' } });
  await create(token, { memberId: String(memberOther._id), subscriptionId: String(subscriptionOther._id) });
});

test('cancelled subscriptions reject new payments but preserve recorded payment history', async () => {
  const token = await login(); const data = await create(token);
  await models.MemberSubscription.updateOne({ _id: subscriptionA._id }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
  error(await send('post', path(), token, input()), 409, 'PAYMENT_SUBSCRIPTION_CANCELLED');
  assert.deepEqual((await send('get', `${path()}/${data.id}`, token)).body.data, data);
});

test('digital methods require references while cash/other permit omitted references', async () => {
  const token = await login();
  for (const paymentMethod of ['upi', 'bank_transfer', 'card']) {
    error(await send('post', path(), token, input({ paymentMethod })), 400, 'VALIDATION_ERROR');
    await create(token, { paymentMethod, transactionReference: `REF-${paymentMethod}`, amountPaise: 1 });
  }
  await create(token, { paymentMethod: 'cash', amountPaise: 1 }); await create(token, { paymentMethod: 'other', amountPaise: 1 });
});

test('successful reference uniqueness is trimmed, per gym and method, and race-safe', async () => {
  const token = await login();
  const results = await Promise.all([' REF-123 ', 'REF-123'].map((transactionReference) => send('post', path(), token, input({ transactionReference, amountPaise: 1 }))));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  error(results.find((result) => result.status === 409), 409, 'DUPLICATE_PAYMENT_REFERENCE');
  await create(token, { transactionReference: 'REF-123', paymentMethod: 'upi', amountPaise: 1 });
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  await create(token, { memberId: String(memberB._id), subscriptionId: String(subscriptionB._id), transactionReference: 'REF-123', amountPaise: 1 }, gymB);
  assert.equal(await models.Payment.countDocuments(), 3);
});

test('trainer read scope follows active assignments and cannot be expanded by filters', async () => {
  const adminToken = await login(); const own = await create(adminToken);
  const other = await create(adminToken, { memberId: String(memberOther._id), subscriptionId: String(subscriptionOther._id) });
  const token = await login(trainer);
  assert.deepEqual((await send('get', path(), token)).body.data, [own]);
  assert.equal((await send('get', `${path()}/${own.id}`, token)).status, 200);
  error(await send('get', `${path()}/${other.id}`, token), 404, 'PAYMENT_NOT_FOUND');
  const filtered = await send('get', `${path()}?memberId=${memberOther._id}&subscriptionId=${subscriptionOther._id}&limit=100`, token);
  assert.deepEqual(filtered.body.data, []); assert.equal(filtered.body.meta.pagination.total, 0);
  error(await send('get', `${path()}?trainerId=${trainerA._id}`, token), 400, 'VALIDATION_ERROR');
  await models.TrainerMemberAssignment.updateOne({ _id: assignment._id }, { $set: { status: 'inactive' } });
  error(await send('get', `${path()}/${own.id}`, token), 404, 'PAYMENT_NOT_FOUND'); assert.equal((await send('get', path(), token)).body.data.length, 0);
});

test('unlinked/inactive/suspended/ambiguous trainer identities fail closed', async () => {
  const token = await login(trainer);
  for (const status of ['inactive', 'suspended']) {
    await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status } }); error(await send('get', path(), token), 403, 'FORBIDDEN');
  }
  await models.TrainerProfile.updateOne({ _id: trainerA._id }, { $set: { status: 'active' } });
  await models.TrainerProfile.create({ gymId: gymA._id, userId: trainer._id, trainerCode: 'TR02', firstName: 'Pat', lastName: 'Smith', phone: '9876543211' });
  error(await send('get', path(), token), 403, 'FORBIDDEN');
  await models.TrainerProfile.collection.updateMany({ userId: trainer._id }, { $unset: { userId: '' } }); error(await send('get', path(), token), 403, 'FORBIDDEN');
});

test('payment IDOR and cross-gym listing fail even for an admin with access to both gyms', async () => {
  const token = await login(); const own = await create(token);
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const foreign = await create(token, { memberId: String(memberB._id), subscriptionId: String(subscriptionB._id) }, gymB);
  error(await send('get', `${path()}/${foreign.id}`, token), 404, 'PAYMENT_NOT_FOUND');
  const listed = await send('get', path(), token); assert.deepEqual(listed.body.data, [own]); assert.equal(listed.body.meta.pagination.total, 1);
  error(await send('get', `${path()}/${foreign.id}`, await login(trainer)), 404, 'PAYMENT_NOT_FOUND');
});

test('all historical payment fields are immutable and generic mutation routes do not exist', async () => {
  const token = await login(); const data = await create(token, { transactionReference: 'RECEIPT-1', notes: 'Original' });
  error(await send('patch', `${path()}/${data.id}`, token, { amountPaise: 1 }), 404, 'NOT_FOUND');
  error(await send('delete', `${path()}/${data.id}`, token), 404, 'NOT_FOUND');
  await models.Payment.findOneAndUpdate({ _id: data.id }, { $set: { gymId: gymB._id, memberId: memberOther._id,
    subscriptionId: subscriptionOther._id, amountPaise: 1, recordedByUserId: trainer._id, status: 'cancelled',
    paymentMethod: 'other', paidAt: new Date('2000-01-01'), transactionReference: 'Changed', notes: 'Changed' } });
  const preserved = (await send('get', `${path()}/${data.id}`, token)).body.data;
  for (const field of Object.keys(data).filter((field) => field !== 'updatedAt')) assert.equal(preserved[field], data[field]);
});

test('strict money, method, date, reference and protected-field validation rejects unsafe inputs', async () => {
  const token = await login();
  for (const fields of [{ amountPaise: 0 }, { amountPaise: -1 }, { amountPaise: 1.5 }, { amountPaise: 1_000_000_001 },
    { amountPaise: '1500.50' }, { amountPaise: null }, { amountPaise: {} }, { paymentMethod: 'gateway' },
    { paidAt: 'bad' }, { paidAt: '2024-02-30T00:00:00Z' }, { paidAt: '2024-01-01' }, { paidAt: '2999-01-01T00:00:00Z' },
    { paidAt: '1969-12-31T23:59:59Z' }, { transactionReference: '' }, { transactionReference: 'ab' },
    { transactionReference: 'x'.repeat(121) }, { transactionReference: '<script>' }, { transactionReference: 'bad\nref' },
    { transactionReference: String(subscriptionA._id) }, { notes: 'x'.repeat(2001) }, { notes: '' }, { memberId: 'invalid' },
    { subscriptionId: 'invalid' }, { gymId: String(gymB._id) }, { userId: String(trainer._id) }, { recordedByUserId: String(trainer._id) },
    { status: 'succeeded' }, { role: 'admin' }, { permissions: ['all'] }, { createdAt: new Date().toISOString() },
    { updatedAt: new Date().toISOString() }, { $set: { amountPaise: 1 } }]) {
    error(await send('post', path(), token, input(fields)), 400, 'VALIDATION_ERROR');
  }
  assert.equal(await models.Payment.countDocuments(), 0);
});

test('NaN/Infinity are rejected and UTC-offset timestamps preserve the actual instant', async () => {
  const token = await login(); const { auth, authorization } = await context();
  for (const amountPaise of [NaN, Infinity, -Infinity]) {
    await assert.rejects(service().create(auth, authorization, input({ amountPaise })), { code: 'VALIDATION_ERROR' });
    await assert.rejects(models.Payment.create({ ...input({ amountPaise }), gymId: gymA._id }), { name: 'ValidationError' });
  }
  const data = await create(token, { paidAt: '2024-01-01T12:30:00+05:30' }); assert.equal(data.paidAt, '2024-01-01T07:00:00.000Z');
});

test('pagination, member/subscription/status/method and inclusive timestamp range filters work', async () => {
  const token = await login();
  for (const paidAt of ['2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z']) await create(token, { paidAt });
  const first = await send('get', `${path()}?page=1&limit=2`, token); const second = await send('get', `${path()}?page=2&limit=2`, token);
  assert.deepEqual(first.body.meta.pagination, { page: 1, limit: 2, total: 3 }); assert.equal(second.body.data.length, 1);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((value) => value.id)).size, 3);
  const filtered = await send('get', `${path()}?memberId=${memberA._id}&subscriptionId=${subscriptionA._id}&status=succeeded&paymentMethod=cash&paidFrom=2024-02-01T00:00:00Z&paidTo=2024-02-01T00:00:00Z`, token);
  assert.equal(filtered.status, 200); assert.equal(filtered.body.meta.pagination.total, 1);
  for (const status of ['pending', 'failed', 'cancelled']) assert.equal((await send('get', `${path()}?status=${status}`, token)).body.data.length, 0);
});

test('unsafe filters, invalid IDs, reversed date ranges and pagination are rejected', async () => {
  const token = await login();
  for (const suffix of ['memberId[$ne]=x', 'subscriptionId[$ne]=x', 'status[$ne]=x', '$where=true', 'gymId=x',
    'role=admin', 'memberId=x', 'subscriptionId=x', 'status=invalid', 'paymentMethod=invalid', 'page=0', 'page=1.5',
    'page=10001', 'limit=101', 'limit[]=1', 'memberId=x&memberId=y', 'paidFrom=bad', 'paidFrom=2024-02-01T00:00:00Z&paidTo=2024-01-01T00:00:00Z']) {
    error(await send('get', `${path()}?${suffix}`, token), 400, 'VALIDATION_ERROR');
  }
  error(await send('get', `${path()}/invalid`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', path({ _id: 'invalid' }), token), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/${missingId()}`, token), 404, 'PAYMENT_NOT_FOUND');
});

test('database failures roll back payment and subscription serialization without exposing details', async (t) => {
  const token = await login();
  for (const [model, method, verb, url, body] of [[models.GymAccess, 'findOne', 'post', path(), input()],
    [models.Gym, 'findOne', 'post', path(), input()], [models.MemberSubscription, 'findOneAndUpdate', 'post', path(), input()],
    [models.MemberProfile, 'findOne', 'post', path(), input()], [models.Payment, 'find', 'post', path(), input()],
    [models.Payment, 'create', 'post', path(), input()], [models.Payment, 'aggregate', 'get', path()]]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private database details'); });
    const response = await send(verb, url, token, body); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(JSON.stringify(response.body).includes('private'), false); mock.mock.restore();
  }
  assert.equal(await models.Payment.countDocuments(), 0); assert.equal((await models.MemberSubscription.findById(subscriptionA._id)).__v, 0);
});

test('direct service calls reject missing or stale gym authorization', async () => {
  const token = await login(); const data = await create(token); const { auth, authorization } = await context();
  const operations = [(scope) => service().create(auth, scope, input()), (scope) => service().get(auth, scope, data.id),
    (scope) => service().list(auth, scope, { page: 1, limit: 20 })];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { $set: { status: 'inactive' } });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
});

test('bootstrap listener and alternate paths do not bypass payment authentication', async () => {
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
  error(await request(bootstrap).get(path()), 401, 'INVALID_AUTHENTICATION');
  assert.equal((await send('get', '/api/v1/payments', await login())).status, 404);
});

test('corrupt payment/member/subscription relationships are never exposed', async () => {
  const token = await login(); const data = await create(token);
  await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { subscriptionId: subscriptionOther._id } });
  error(await send('get', `${path()}/${data.id}`, token), 404, 'PAYMENT_NOT_FOUND');
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 0);
  await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { subscriptionId: subscriptionB._id } });
  error(await send('get', `${path()}/${data.id}`, token), 404, 'PAYMENT_NOT_FOUND');
});

test('startup creates partial reference uniqueness and preserves unrelated indexes', async () => {
  await models.Payment.collection.dropIndexes(); await models.Payment.collection.createIndex({ notes: 1 }, { name: 'retained_payment_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.Payment.listIndexes(); const unique = indexes.find((value) => value.name === 'payment_gym_method_reference_unique');
    assert.equal(unique.unique, true); assert.deepEqual(unique.partialFilterExpression, { status: 'succeeded', transactionReference: { $type: 'string' } });
    assert.ok(indexes.some((value) => value.name === 'retained_payment_index'));
  } finally { await lifecycle.shutdown('test'); }
});

test('maximum bounded paise amount is exact and corrupt totals fail closed', async () => {
  const token = await login();
  await models.MemberSubscription.collection.updateOne({ _id: subscriptionA._id }, { $set: { pricePaiseSnapshot: 1_000_000_000 } });
  const data = await create(token, { amountPaise: 1_000_000_000 }); assert.equal(data.amountPaise, 1_000_000_000);
  error(await send('post', path(), token, input({ amountPaise: 1 })), 409, 'PAYMENT_OVERPAYMENT');
  await models.Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(data.id) }, { $set: { amountPaise: 0.5 } });
  error(await send('post', path(), token, input({ amountPaise: 1 })), 500, 'INTERNAL_SERVER_ERROR');
});

test('recording arrears for an inactive member leaves member and subscription business fields intact', async () => {
  const token = await login(); await models.MemberProfile.updateOne({ _id: memberA._id }, { $set: { status: 'inactive' } });
  const data = await create(token); assert.equal(data.status, 'succeeded');
  assert.equal((await models.MemberProfile.findById(memberA._id)).status, 'inactive');
  assert.equal((await models.MemberSubscription.findById(subscriptionA._id)).status, 'active');
});

test('authorization and ownership denials never reach payment controllers', async () => {
  const express = require('express');
  const { createPaymentRouter } = require('../../src/modules/payments/payment.routes');
  const { createAuthService } = require('../../src/modules/auth/auth.service');
  const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
  const requestId = require('../../src/middleware/requestId');
  const errorHandler = require('../../src/middleware/errorHandler');
  const other = await create(await login(), { memberId: String(memberOther._id), subscriptionId: String(subscriptionOther._id) });
  let calls = 0; const denied = async () => { calls += 1; throw new Error('Controller reached'); };
  const guarded = express(); guarded.use(requestId); guarded.use(express.json());
  guarded.use('/api/v1/gyms/:gymId/payments', createPaymentRouter({ ...service(), create: denied, list: denied, get: denied },
    createAuthService({ ...models, config }), createAuthorizationMiddleware(createAuthorizationService(models))));
  guarded.use(errorHandler);
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [verb, url, body] of [['post', path(), input()], ['get', `${path()}/${other.id}`], ...(account === member ? [['get', path()]] : [])]) {
      const pending = request(guarded)[verb](url).set('Authorization', `Bearer ${token}`); if (body) pending.send(body);
      const ownDenial = account === trainer && verb === 'get';
      error(await pending, ownDenial ? 404 : 403, ownDenial ? 'PAYMENT_NOT_FOUND' : 'FORBIDDEN');
    }
  }
  assert.equal(calls, 0);
});

test('standalone MongoDB fails payment creation closed without an unsafe fallback', async () => {
  const standalone = await startTestMongo(); const localConfig = { ...config, mongoUri: standalone.uri };
  const local = createDatabase({ logger: createLogger(localConfig) });
  try {
    await local.connect(localConfig); createApp({ config: localConfig, database: local });
    const localModels = local.connection.models;
    await Promise.all(Object.values(localModels).map((model) => model.createIndexes()));
    await login(); const { auth, authorization } = await context();
    const standaloneService = createPaymentService({ ...localModels, authorizationService: createAuthorizationService(models) });
    await assert.rejects(standaloneService.create(auth, authorization, input()), { code: 'PAYMENT_STORAGE_UNAVAILABLE' });
    assert.equal(await localModels.Payment.countDocuments(), 0);
  } finally { await local.disconnect(); await standalone.stop(); }
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
  const period = { startDate: new Date(`${day()}T00:00:00Z`), endDate: new Date(`${day(30)}T00:00:00Z`),
    planNameSnapshot: 'Monthly', durationDaysSnapshot: 30, pricePaiseSnapshot: 150000 };
  subscriptionA = await models.MemberSubscription.create({ ...period, gymId: gymA._id, memberId: memberA._id, membershipPlanId: planA._id });
  subscriptionOther = await models.MemberSubscription.create({ ...period, gymId: gymA._id, memberId: memberOther._id, membershipPlanId: planA._id });
  subscriptionB = await models.MemberSubscription.create({ ...period, gymId: gymB._id, memberId: memberB._id, membershipPlanId: planB._id });
});

// Dashboard collection supplies one key per unchanged logical receipt.
test('idempotent cash replay returns the same immutable receipt without another installment', async () => {
  const token = await login(); const body = input();
  const first = await send('post', path(), token, body).set('Idempotency-Key', 'cash-replay-0001');
  assert.equal(first.status, 201);
  const replay = await send('post', path(), token, body).set('Idempotency-Key', 'cash-replay-0001');
  assert.equal(replay.status, 201); assert.deepEqual(replay.body.data, first.body.data);
  assert.equal(await models.Payment.countDocuments({ gymId: gymA._id }), 1);
  assert.equal(replay.body.data.idempotencyKeyDigest, undefined); assert.equal(replay.body.data.requestDigest, undefined);
  await models.MemberSubscription.updateOne({ _id: subscriptionA._id }, { status: 'cancelled' });
  const afterCancel = await send('post', path(), token, body).set('Idempotency-Key', 'cash-replay-0001');
  assert.equal(afterCancel.status, 201); assert.deepEqual(afterCancel.body.data, first.body.data);
});
test('concurrent identical keys create exactly one payment', async () => {
  const token = await login(); const body = input();
  const responses = await Promise.all(Array.from({ length: 4 }, () => send('post', path(), token, body).set('Idempotency-Key', 'concurrent-cash-0001')));
  assert.deepEqual(responses.map((r) => r.status), [201, 201, 201, 201]);
  assert.equal(new Set(responses.map((r) => r.body.data.id)).size, 1);
  assert.equal(await models.Payment.countDocuments({ gymId: gymA._id }), 1);
});
test('changed payload under a committed key conflicts and cannot add a payment', async () => {
  const token = await login(); const body = input();
  assert.equal((await send('post', path(), token, body).set('Idempotency-Key', 'conflict-cash-0001')).status, 201);
  error(await send('post', path(), token, { ...body, amountPaise: 50001 }).set('Idempotency-Key', 'conflict-cash-0001'), 409, 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(await models.Payment.countDocuments({ gymId: gymA._id }), 1);
});
test('new installment keys preserve partial/final payment and overpayment rules', async () => {
  const token = await login();
  for (const [key, amount] of [['partial-0001', 50000], ['final-0002', 100000]]) {
    const body = input({ amountPaise: amount });
    const first = await send('post', path(), token, body).set('Idempotency-Key', key);
    assert.equal(first.status, 201);
    assert.deepEqual((await send('post', path(), token, body).set('Idempotency-Key', key)).body.data, first.body.data);
  }
  error(await send('post', path(), token, input({ amountPaise: 1 })).set('Idempotency-Key', 'overpay-0003'), 409, 'PAYMENT_OVERPAYMENT');
  assert.equal(await models.Payment.countDocuments({ gymId: gymA._id }), 2);
});
test('idempotent replay still requires current authorization and gym isolation', async () => {
  const token = await login(); const body = input();
  assert.equal((await send('post', path(), token, body).set('Idempotency-Key', 'scoped-key-0001')).status, 201);
  error(await send('post', path(gymB), token, body).set('Idempotency-Key', 'scoped-key-0001'), 403, 'FORBIDDEN');
  await models.GymAccess.updateOne({ gymId: gymA._id, userId: admin._id }, { status: 'inactive' });
  error(await send('post', path(), token, body).set('Idempotency-Key', 'scoped-key-0001'), 403, 'FORBIDDEN');
});
test('malformed idempotency headers fail validation before insertion', async () => {
  const token = await login();
  for (const key of ['short', 'invalid space key', 'a'.repeat(129)]) error(await send('post', path(), token, input()).set('Idempotency-Key', key), 400, 'VALIDATION_ERROR');
  assert.equal(await models.Payment.countDocuments({ gymId: gymA._id }), 0);
});
test('calendar payment history uses inclusive gym dates, successful totals and unpaginated summary', async () => {
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'Asia/Kolkata' });
  const token = await login();
  for (const paidAt of ['2024-01-31T18:30:00.000Z', '2024-02-01T18:29:59.999Z', '2024-02-01T18:30:00.000Z']) await create(token, { amountPaise: 10000, paidAt });
  const query = '?from=2024-02-01&to=2024-02-01&status=succeeded&includeMember=true&limit=1';
  const first = await send('get', path() + query, token);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.meta.summary, { successfulAmountPaise: 20000, successfulPaymentCount: 2 });
  assert.equal(first.body.data.length, 1); assert.equal(first.body.meta.pagination.total, 2);
  assert.equal(first.body.meta.period.startUtc, '2024-01-31T18:30:00.000Z');
  assert.equal(first.body.meta.period.endUtc, '2024-02-01T18:30:00.000Z');
  assert.equal(first.body.data[0].member.id, String(memberA._id));
  assert.equal(first.body.data[0].member.phone, memberA.phone);
  const second = await send('get', path() + query + '&page=2', token);
  assert.deepEqual(second.body.meta.summary, first.body.meta.summary);
  assert.notEqual(second.body.data[0].id, first.body.data[0].id);
  assert.doesNotMatch(JSON.stringify(first.body), /passwordHash|accessToken|refreshToken|idempotencyKeyDigest|requestDigest/);
});
test('calendar history allows future calendar endpoints, empty state and DST midnight bounds', async () => {
  const token = await login();
  const empty = await send('get', path() + '?from=2026-10-01&to=2026-10-31&status=succeeded', token);
  assert.equal(empty.status, 200); assert.deepEqual(empty.body.meta.summary, { successfulAmountPaise: 0, successfulPaymentCount: 0 });
  await models.Gym.updateOne({ _id: gymA._id }, { 'settings.timezone': 'America/New_York' });
  const dst = await send('get', path() + '?from=2024-03-10&to=2024-03-10', token);
  assert.equal(dst.status, 200); assert.equal(dst.body.meta.period.startUtc, '2024-03-10T05:00:00.000Z'); assert.equal(dst.body.meta.period.endUtc, '2024-03-11T04:00:00.000Z');
});
test('calendar history rejects invalid, reversed, overlong and mixed date filters', async () => {
  const token = await login();
  for (const query of ['from=2024-02-30', 'from=2024-02-02&to=2024-02-01', 'from=2024-01-01&to=2025-01-01', 'from=2024-02-01&paidFrom=2024-02-01T00:00:00Z']) error(await send('get', path() + '?' + query, token), 400, 'VALIDATION_ERROR');
});
