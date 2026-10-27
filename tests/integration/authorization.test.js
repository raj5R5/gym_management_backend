const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp: createRuntimeApp } = require('../../src/app');
const { historicalRecords } = require('../helpers/historicalRecords');
const createApp = (options) => { const app = createRuntimeApp(options); historicalRecords(options.database?.connection); return app; };
const { createAuthService } = require('../../src/modules/auth/auth.service');
const { createAuthRouter } = require('../../src/modules/auth/auth.routes');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createAuthorizationMiddleware } = require('../../src/middleware/authorize');
const authenticate = require('../../src/middleware/authenticate');
const requestId = require('../../src/middleware/requestId');
const errorHandler = require('../../src/middleware/errorHandler');

let isolated, database, config, models, app, middleware, service, actor, other, firstGym, secondGym, grant, passwordHash;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const gymPath = (gymId, operation = 'any') => `/test/gyms/${gymId}/${operation}`;

function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'meta', 'success']);
}
function get(path, token) {
  const pending = request(app).get(path);
  return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
}
async function login(user = actor) {
  const response = await request(app).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' });
  assert.equal(response.status, 200);
  return response.body.data;
}

before(async () => {
  await initializePasswords();
  passwordHash = await hashPassword(password);
  isolated = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  createApp({ config, database });
  models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
  const auth = createAuthService({ ...models, config });
  service = createAuthorizationService(models);
  middleware = createAuthorizationMiddleware(service);
  // These probes exist only in tests: they do not define public API contracts.
  app = express();
  app.use(requestId);
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/v1/auth', createAuthRouter(auth, config));
  const respond = (req, res) => res.json({ success: true, data: req.authorization, meta: { requestId: req.id } });
  for (const [operation, allowed] of [
    ['any', ['admin', 'trainer', 'member']], ['admin', ['admin']],
    ['trainer', ['trainer']], ['member', ['member']], ['staff', ['admin', 'trainer']],
  ]) {
    app.get(gymPath(':gymId', operation), authenticate(auth), middleware.requireGymAccess,
      middleware.requireRoles(...allowed), respond);
  }
  app.get('/test/no-auth/:gymId', middleware.requireGymAccess, respond);
  app.get('/test/no-scope', authenticate(auth), middleware.requireRoles('admin'), respond);
  app.get('/test/changed-scope/:gymId', authenticate(auth), middleware.requireGymAccess,
    (req, _res, next) => { req.params.gymId = String(secondGym._id); next(); },
    middleware.requireRoles('admin'), respond);
  app.use(errorHandler);
});
after(async () => {
  try { if (database) await database.disconnect(); }
  finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
  actor = await models.UserAccount.create({ email: 'actor@example.com', status: 'active', passwordHash });
  other = await models.UserAccount.create({ email: 'other@example.com', status: 'active', passwordHash });
  firstGym = await models.Gym.create({ name: 'First Gym', nameKey: 'first gym', status: 'active' });
  secondGym = await models.Gym.create({ name: 'Second Gym', nameKey: 'second gym', status: 'active' });
  grant = await models.GymAccess.create({ userId: actor._id, gymId: firstGym._id, role: 'admin', status: 'active' });
});

test('gym scope and role come from stored access, with a minimal immutable context', async () => {
  const data = await login();
  const response = await get(gymPath(firstGym._id), data.accessToken);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { userId: String(actor._id), gymId: String(firstGym._id),
    gymAccessId: String(grant._id), role: 'admin' });
  const context = await service.requireGymAccess({ user: actor, session: await models.AuthSession.findOne().lean() },
    String(firstGym._id));
  assert.equal(Object.isFrozen(context), true);
  for (const field of ['passwordHash', 'email', 'accessToken', 'refreshToken']) assert.equal(field in context, false);
});

test('each role obeys exact route allowlists without an implicit admin override', async () => {
  const data = await login();
  for (const role of ['admin', 'trainer', 'member']) {
    await models.GymAccess.updateOne({ _id: grant._id }, { $set: { role } });
    for (const operation of ['admin', 'trainer', 'member']) {
      const response = await get(gymPath(firstGym._id, operation), data.accessToken);
      if (role === operation) assert.equal(response.status, 200);
      else expectError(response, 403, 'FORBIDDEN');
    }
    assert.equal((await get(gymPath(firstGym._id), data.accessToken)).status, 200);
    const staff = await get(gymPath(firstGym._id, 'staff'), data.accessToken);
    if (role === 'member') expectError(staff, 403, 'FORBIDDEN');
    else assert.equal(staff.status, 200);
  }
});

test('missing, malformed and expired tokens produce 401 before authorization', async () => {
  expectError(await get(gymPath(firstGym._id)), 401, 'INVALID_AUTHENTICATION');
  expectError(await get(gymPath(firstGym._id), 'malformed'), 401, 'INVALID_AUTHENTICATION');
  const data = await login();
  const claims = jwt.decode(data.accessToken);
  const expired = jwt.sign({ sid: claims.sid }, config.jwtAccessSecret, { algorithm: 'HS256',
    subject: claims.sub, issuer: config.jwtIssuer, audience: config.jwtAudience, expiresIn: -1 });
  expectError(await get(gymPath(firstGym._id), expired), 401, 'INVALID_AUTHENTICATION');
});

test('inactive and suspended accounts are denied with their previously valid JWT', async () => {
  const data = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.UserAccount.updateOne({ _id: actor._id }, { $set: { status } });
    expectError(await get(gymPath(firstGym._id), data.accessToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('revoked and expired sessions cannot authorize gym operations', async () => {
  const data = await login();
  const sid = jwt.decode(data.accessToken).sid;
  for (const update of [{ status: 'revoked' }, { status: 'active', expiresAt: new Date(0) },
    { expiresAt: new Date(Date.now() + 60000), idleExpiresAt: new Date(0) }]) {
    await models.AuthSession.updateOne({ _id: sid }, { $set: update });
    expectError(await get(gymPath(firstGym._id), data.accessToken), 401, 'INVALID_AUTHENTICATION');
  }
});

test('inactive, suspended and removed gym access take effect without issuing a new JWT', async () => {
  const data = await login();
  for (const status of ['inactive', 'suspended']) {
    await models.GymAccess.updateOne({ _id: grant._id }, { $set: { status } });
    expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
  }
  await models.GymAccess.deleteOne({ _id: grant._id });
  expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
});

test('missing/inactive gyms and missing access all return the same authorization denial', async () => {
  const data = await login();
  expectError(await get(gymPath(secondGym._id), data.accessToken), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: firstGym._id }, { $set: { status: 'inactive' } });
  expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
  await models.Gym.deleteOne({ _id: firstGym._id });
  expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
  expectError(await get(gymPath(missingId()), data.accessToken), 403, 'FORBIDDEN');
});

test('one account can have different roles in different gyms with no cross-gym privilege', async () => {
  await models.GymAccess.create({ userId: actor._id, gymId: secondGym._id, role: 'member', status: 'active' });
  const data = await login();
  assert.equal((await get(gymPath(firstGym._id, 'admin'), data.accessToken)).status, 200);
  expectError(await get(gymPath(secondGym._id, 'admin'), data.accessToken), 403, 'FORBIDDEN');
  assert.equal((await get(gymPath(secondGym._id, 'member'), data.accessToken)).status, 200);
});

test('another account cannot borrow an existing user grant', async () => {
  const data = await login(other);
  expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
});

test('client body, query, headers and signed JWT role claims cannot grant authorization', async () => {
  await models.GymAccess.updateOne({ _id: grant._id }, { $set: { role: 'member' } });
  const data = await login();
  const claims = jwt.decode(data.accessToken);
  const token = jwt.sign({ sid: claims.sid, role: 'admin', gymId: String(secondGym._id), permissions: ['all'] },
    config.jwtAccessSecret, { algorithm: 'HS256', subject: claims.sub, issuer: config.jwtIssuer,
      audience: config.jwtAudience, expiresIn: 600 });
  const response = await get(`${gymPath(firstGym._id, 'admin')}?role=admin&gymId=${secondGym._id}`, token)
    .set('X-Role', 'admin').set('X-Gym-ID', String(firstGym._id))
    .send({ role: 'admin', gymId: String(firstGym._id), userId: String(actor._id), authorization: { role: 'admin' } });
  expectError(response, 403, 'FORBIDDEN');
});





test('missing authentication or scope middleware fails closed', async () => {
  expectError(await get(`/test/no-auth/${firstGym._id}`), 401, 'INVALID_AUTHENTICATION');
  const data = await login();
  expectError(await get('/test/no-scope', data.accessToken), 403, 'FORBIDDEN');
  assert.throws(() => middleware.requireRoles(), TypeError);
  assert.throws(() => middleware.requireRoles('owner'), TypeError);
});

test('unknown persisted role and unexpected database errors fail closed', async (t) => {
  const data = await login();
  // Bypass schema validation only in this isolated fixture to simulate corrupt/legacy data.
  await models.GymAccess.collection.updateOne({ _id: grant._id }, { $set: { role: 'superadmin' } });
  expectError(await get(gymPath(firstGym._id), data.accessToken), 403, 'FORBIDDEN');
  t.mock.method(models.GymAccess, 'findOne', () => { throw new Error('private database credential'); });
  const response = await get(gymPath(firstGym._id), data.accessToken);
  expectError(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('roles cannot reuse another account context', async () => {
  const data = await login();
  const session = await models.AuthSession.findById(jwt.decode(data.accessToken).sid).lean();
  const context = await service.requireGymAccess({ user: actor, session }, String(firstGym._id));
  assert.throws(() => service.requireRoles({ user: other, session: { ...session, userId: other._id } }, context, ['admin']),
    { code: 'FORBIDDEN' });
});


test('role guards reject a URL scope changed after authorization', async () => {
  const data = await login();
  expectError(await get(`/test/changed-scope/${firstGym._id}`, data.accessToken), 403, 'FORBIDDEN');
});

// Deliberately alter server-side context to reproduce the reviewed composition
// hazard. No fixture context is accepted from HTTP input.
function scopeProbe(alter) {
  const probe = express();
  const observed = { protectedCalls: 0, retainedOnError: undefined };
  probe.use(requestId);
  probe.get('/probe/gyms/:gymId', authenticate(createAuthService({ ...models, config })),
    middleware.requireGymAccess, (req, _res, next) => { alter(req); next(); },
    middleware.requireRoles('admin'),
    (_req, res) => { observed.protectedCalls += 1; res.json({ success: true }); });
  probe.use((error, req, _res, next) => {
    observed.retainedOnError = req.authorization !== undefined;
    next(error);
  });
  probe.use(errorHandler);
  return { probe, observed };
}
async function probeRequest(probe, token) {
  return request(probe).get(`/probe/gyms/${firstGym._id}`).set('Authorization', `Bearer ${token}`);
}

test('gym-scoped role checks deny missing URL gym scope and clear previous context', async () => {
  const data = await login();
  for (const alter of [
    (req) => { delete req.params.gymId; },
    (req) => { req.params = undefined; },
    (req) => { req.params.gymId = ''; },
  ]) {
    const { probe, observed } = scopeProbe(alter);
    expectError(await probeRequest(probe, data.accessToken), 403, 'FORBIDDEN');
    assert.equal(observed.protectedCalls, 0);
    assert.equal(observed.retainedOnError, false);
  }
});

test('gym-scoped role checks deny malformed URL gym scope without reaching the handler', async () => {
  const data = await login();
  for (const value of ['invalid', 'a'.repeat(25), null, 123, {}, []]) {
    const { probe, observed } = scopeProbe((req) => { req.params.gymId = value; });
    expectError(await probeRequest(probe, data.accessToken), 403, 'FORBIDDEN');
    assert.equal(observed.protectedCalls, 0);
    assert.equal(observed.retainedOnError, false);
  }
});

test('role checks deny incomplete or malformed authorization contexts despite matching account ID', async () => {
  const data = await login();
  const complete = { userId: String(actor._id), gymId: String(firstGym._id),
    gymAccessId: String(grant._id), role: 'admin' };
  const invalid = [undefined, { userId: complete.userId, role: 'admin' }];
  for (const field of ['userId', 'gymId', 'gymAccessId', 'role']) {
    const missing = { ...complete }; delete missing[field]; invalid.push(missing);
  }
  for (const field of ['userId', 'gymId', 'gymAccessId']) {
    for (const value of ['', 'invalid', null, {}, []]) invalid.push({ ...complete, [field]: value });
  }
  for (const context of invalid) {
    const { probe, observed } = scopeProbe((req) => { req.authorization = context; });
    expectError(await probeRequest(probe, data.accessToken), 403, 'FORBIDDEN');
    assert.equal(observed.protectedCalls, 0);
    assert.equal(observed.retainedOnError, false);
  }
});

test('complete matching gym scope still reaches the protected handler, including uppercase URL IDs', async () => {
  const data = await login();
  for (const alter of [() => {}, (req) => { req.params.gymId = req.params.gymId.toUpperCase(); }]) {
    const { probe, observed } = scopeProbe(alter);
    assert.equal((await probeRequest(probe, data.accessToken)).status, 200);
    assert.equal(observed.protectedCalls, 1);
    assert.equal(observed.retainedOnError, undefined);
  }
});

test('stale scope for another gym is cleared and never reaches the protected handler', async () => {
  const data = await login();
  const { probe, observed } = scopeProbe((req) => { req.params.gymId = String(secondGym._id); });
  expectError(await probeRequest(probe, data.accessToken), 403, 'FORBIDDEN');
  assert.equal(observed.protectedCalls, 0);
  assert.equal(observed.retainedOnError, false);
});

test('direct role service calls require explicit valid matching gym scope', async () => {
  const data = await login();
  const auth = { user: actor, session: await models.AuthSession.findById(jwt.decode(data.accessToken).sid).lean() };
  const context = await service.requireGymAccess(auth, String(firstGym._id));
  for (const gymId of [undefined, '', 'invalid', String(secondGym._id)]) {
    assert.throws(() => service.requireRoles(auth, context, ['admin'], gymId), { code: 'FORBIDDEN' });
  }
  assert.doesNotThrow(() => service.requireRoles(auth, context, ['admin'], String(firstGym._id)));
});
