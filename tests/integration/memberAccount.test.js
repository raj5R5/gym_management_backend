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
const { createMemberAccountService } = require('../../src/modules/memberAccount/account.service');
const { createHash } = require('node:crypto');
const { startServer } = require('../../src/server');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash, memberA, memberB;
const password = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/members/${memberA._id}/account`;
const input = (overrides = {}) => ({ email: 'New.Member@EXAMPLE.com', displayName: 'New Member', ...overrides });
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
  return createMemberAccountService({ ...models, authorizationService: createAuthorizationService(models) });
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

const memberPath = (profile = memberA, gym = gymA) => `/api/v1/gyms/${gym._id}/members/${profile._id}/account`;
async function provision(token, body = input(), profile = memberA, gym = gymA) {
  const response = await send('post', memberPath(profile, gym), token, body); assert.equal(response.status, 201, JSON.stringify(response.body.error)); return response.body.data;
}
const activate = (token, chosenPassword = password) => send('post', '/api/v1/account/activate', undefined, { token, password: chosenPassword });
test('admin provisions an active member without a password and receives one opaque activation credential', async () => {
  const token = await login(); const response = await send('get', path(), token); assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { provisioned: false, gymAccess: null, activated: false });
  const result = await provision(token); assert.equal(result.provisioned, true); assert.equal(result.activated, false);
  assert.deepEqual(result.gymAccess, { role: 'member', status: 'active' }); assert.match(result.activationToken, /^[A-Za-z0-9_-]{43}$/);
  const user = await models.UserAccount.findById(result.userId).select('+passwordHash +normalizedEmail').lean();
  assert.equal(user.normalizedEmail, 'new.member@example.com'); assert.equal(user.displayName, 'New Member'); assert.equal(user.status, 'active'); assert.equal(user.passwordHash, undefined);
  assert.equal(String((await models.MemberProfile.findById(memberA._id)).userId), result.userId);
  const credential = await models.MemberActivation.findOne({ userId: result.userId }).select('+tokenDigest').lean();
  assert.equal(credential.tokenDigest, createHash('sha256').update(result.activationToken).digest('hex'));
  assert.equal(String(credential.memberId), String(memberA._id)); assert.equal(String(credential.gymId), String(gymA._id)); assert.equal(credential.usedAt, null);
  assert.ok(credential.expiresAt > new Date() && credential.expiresAt <= new Date(Date.now() + 15 * 60 * 1000));
  assert.doesNotMatch(JSON.stringify(credential), new RegExp(result.activationToken));
  const status = await send('get', path(), token); assert.equal(status.status, 200);
  assert.deepEqual(status.body.data, { provisioned: true, userId: result.userId, email: 'New.Member@EXAMPLE.com', gymAccess: { role: 'member', status: 'active' }, activated: false });
  assert.equal(status.headers['cache-control'], 'no-store'); assert.doesNotMatch(JSON.stringify(status.body), /password|token|digest|session|__v|"_id"/i);
  error(await send('post', path(), token, input()), 409, 'MEMBER_ACCOUNT_ALREADY_PROVISIONED');
  assert.equal(await models.MemberActivation.countDocuments(), 1);
});
test('activation sets existing Argon2id credential, consumes token and permits normal login without automatic sessions', async () => {
  const adminToken = await login(); const result = await provision(adminToken); const before = await models.AuthSession.countDocuments();
  const response = await activate(result.activationToken); assert.equal(response.status, 200); assert.deepEqual(response.body.data, { activated: true });
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(await models.AuthSession.countDocuments(), before);
  assert.doesNotMatch(JSON.stringify(response.body), /password|token|digest|session/i);
  const user = await models.UserAccount.findById(result.userId).select('+passwordHash').lean();
  assert.ok(user.passwordHash.startsWith('$argon2id$v=19$'));
  assert.deepEqual(user.passwordHash.split('$')[3].split(',').sort(), ['m=65536', 'p=1', 't=3']);
  assert.ok((await models.MemberActivation.findOne({ userId: user._id })).usedAt);
  error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
  const loggedIn = await send('post', '/api/v1/auth/login', undefined, { email: ' new.member@example.com ', password, client: 'mobile' });
  assert.equal(loggedIn.status, 200); assert.equal(loggedIn.body.data.gymAccess[0].role, 'member');
  const refresh = await send('post', '/api/v1/auth/refresh', undefined, { refreshToken: loggedIn.body.data.refreshToken }); assert.equal(refresh.status, 200);
  assert.notEqual(refresh.body.data.refreshToken, loggedIn.body.data.refreshToken);
  assert.equal((await send('get', path(), adminToken)).body.data.activated, true);
});
test('trainers, members and anonymous clients cannot provision, inspect or revoke', async () => {
  for (const account of [trainer, member]) {
    const token = await login(account);
    for (const [verb, url, body] of [['post', path(), input()], ['get', path()], ['post', path()+'/revoke', {}]]) {
      error(await send(verb, url, token, body), 403, 'FORBIDDEN'); error(await send(verb, url, undefined, body), 401, 'INVALID_AUTHENTICATION');
    }
  }
  assert.equal(await models.MemberActivation.countDocuments(), 0);
});
for (const status of ['inactive', 'suspended']) test(`${status} admin access denies all account operations`, async () => {
  const token = await login(); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  for (const [verb, url, body] of [['post', path(), input()], ['get', path()], ['post', path()+'/revoke', {}]]) error(await send(verb, url, token, body), 403, 'FORBIDDEN');
});
test('inactive gym and foreign or missing members fail closed on all admin operations', async () => {
  const token = await login();
  for (const profile of [memberB, { _id: missingId() }]) for (const [verb, suffix, body] of [['post', '', input()], ['get', ''], ['post', '/revoke', {}]])
    error(await send(verb, memberPath(profile)+suffix, token, body), 404, 'MEMBER_NOT_FOUND');
  error(await send('post', memberPath(memberB, gymB), token, input()), 403, 'FORBIDDEN');
  await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  for (const [verb, suffix, body] of [['post', '', input()], ['get', ''], ['post', '/revoke', {}]]) error(await send(verb, path()+suffix, token, body), 403, 'FORBIDDEN');
});
for (const status of ['inactive', 'suspended']) test(`${status} member cannot be provisioned or silently reactivated`, async () => {
  const token = await login(); await models.MemberProfile.updateOne({ _id: memberA._id }, { status });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
  assert.equal((await models.MemberProfile.findById(memberA._id)).status, status); assert.equal(await models.UserAccount.countDocuments(), 3);
});
test('strict request validation rejects identity overrides, passwords and invalid emails', async () => {
  const token = await login();
  for (const extra of [{ email: 'bad' }, { email: memberA.phone }, { displayName: '' }, { displayName: 'x'.repeat(121) }, { password }, { passwordHash: 'hash' },
    { userId: String(admin._id) }, { gymId: String(gymB._id) }, { role: 'admin' }, { status: 'active' }, { normalizedEmail: 'a@example.com' },
    { accessToken: 'token' }, { refreshToken: 'token' }, { tokenDigest: 'digest' }, { $set: { userId: admin._id } }]) error(await send('post', path(), token, input(extra)), 400, 'VALIDATION_ERROR');
  error(await send('post', path(), token, {}), 400, 'VALIDATION_ERROR');
  error(await send('post', memberPath({ _id: 'bad' }), token, input()), 400, 'VALIDATION_ERROR');
  error(await send('get', path()+'?userId='+admin._id, token), 400, 'VALIDATION_ERROR');
  error(await send('post', path()+'/revoke', token, { status: 'active' }), 400, 'VALIDATION_ERROR');
  assert.equal(await models.MemberActivation.countDocuments(), 0);
});
test('existing email or different member identity is never stolen, merged or replaced', async () => {
  const token = await login();
  error(await send('post', path(), token, input({ email: admin.email })), 409, 'MEMBER_ACCOUNT_IDENTITY_CONFLICT');
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: member._id } });
  error(await send('post', path(), token, input()), 409, 'MEMBER_ACCOUNT_IDENTITY_CONFLICT');
  assert.equal(String((await models.MemberProfile.findById(memberA._id)).userId), String(member._id));
  assert.equal(await models.UserAccount.countDocuments(), 3);
});
test('linked activated global identity gains member access without password or displayName changes', async () => {
  const token = await login(); const user = await models.UserAccount.create({ email: 'linked@example.com', displayName: 'Global Name', status: 'active', passwordHash });
  await models.GymAccess.create({ userId: user._id, gymId: gymB._id, role: 'admin', status: 'active' });
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: user._id } });
  const result = await provision(token, input({ email: 'LINKED@example.com', displayName: 'Untrusted change' }));
  assert.equal(result.userId, String(user._id)); assert.equal(result.activated, true); assert.equal(result.activationToken, undefined);
  assert.equal(await models.MemberActivation.countDocuments(), 0);
  const after = await models.UserAccount.findById(user._id).select('+passwordHash'); assert.equal(after.displayName, 'Global Name'); assert.equal(after.passwordHash, passwordHash);
  assert.equal((await models.GymAccess.findOne({ userId: user._id, gymId: gymB._id })).role, 'admin');
});
test('linked passwordless identity gets one activation credential without modifying global identity', async () => {
  const token = await login(); const user = await models.UserAccount.create({ email: 'linked@example.com', displayName: 'Original', status: 'active' });
  await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: user._id } });
  const result = await provision(token, input({ email: user.email, displayName: 'Changed' })); assert.ok(result.activationToken);
  assert.equal((await models.UserAccount.findById(user._id)).displayName, 'Original'); assert.equal((await activate(result.activationToken)).status, 200);
});
test('existing role/access conflicts and inactive global identity do not mutate access or identity', async () => {
  const token = await login(); await models.MemberProfile.collection.updateOne({ _id: memberA._id }, { $set: { userId: member._id } });
  error(await send('post', path(), token, input({ email: member.email })), 409, 'MEMBER_ACCOUNT_ALREADY_PROVISIONED');
  await models.GymAccess.updateOne({ userId: member._id }, { role: 'trainer' });
  error(await send('post', path()+'/revoke', token, {}), 409, 'MEMBER_ACCOUNT_IDENTITY_CONFLICT');
  assert.equal((await models.GymAccess.findOne({ userId: member._id })).role, 'trainer');
  await models.GymAccess.deleteOne({ userId: member._id }); await models.UserAccount.updateOne({ _id: member._id }, { status: 'suspended' });
  error(await send('post', path(), token, input({ email: member.email })), 403, 'FORBIDDEN');
  assert.equal((await models.UserAccount.findById(member._id)).status, 'suspended');
});
test('activation reuses password policy and rejects malformed credentials or unknown fields', async () => {
  const result = await provision(await login());
  for (const chosen of ['short', 'password123456789', 'abcabcabcabcabcabc', 'x'.repeat(129)]) error(await activate(result.activationToken, chosen), 400, 'VALIDATION_ERROR');
  for (const token of ['', 'bad', 'x'.repeat(44), 'x'.repeat(42)]) error(await activate(token), 400, 'VALIDATION_ERROR');
  for (const extra of [{ role: 'admin' }, { userId: result.userId }, { gymId: String(gymA._id) }]) error(await send('post', '/api/v1/account/activate', undefined,
    { token: result.activationToken, password, ...extra }), 400, 'VALIDATION_ERROR');
  error(await activate(randomBytes(32).toString('base64url')), 401, 'INVALID_ACTIVATION_CREDENTIAL');
  assert.equal((await models.MemberActivation.findOne()).usedAt, null);
});
test('expiration is checked explicitly even while expired credential is still stored', async () => {
  const result = await provision(await login());
  await models.MemberActivation.collection.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
  error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
  assert.equal((await models.UserAccount.findById(result.userId).select('+passwordHash')).passwordHash, undefined);
});
test('concurrent provisioning creates exactly one identity, access and credential', async () => {
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input()), send('post', path(), token, input())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await models.UserAccount.countDocuments(), 4); assert.equal(await models.GymAccess.countDocuments(), 4); assert.equal(await models.MemberActivation.countDocuments(), 1);
  const created = responses.find((response) => response.status === 201).body.data;
  assert.equal(String((await models.MemberProfile.findById(memberA._id)).userId), created.userId);
});
test('concurrent activation consumes once and exactly one password becomes authoritative', async () => {
  const result = await provision(await login()); const secondPassword = randomBytes(24).toString('base64url');
  const responses = await Promise.all([activate(result.activationToken, password), activate(result.activationToken, secondPassword)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
  const winner = responses[0].status === 200 ? password : secondPassword; const loser = winner === password ? secondPassword : password;
  assert.equal((await send('post', '/api/v1/auth/login', undefined, { email: result.email, password: winner, client: 'mobile' })).status, 200);
  error(await send('post', '/api/v1/auth/login', undefined, { email: result.email, password: loser, client: 'mobile' }), 401, 'INVALID_CREDENTIALS');
  error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
});
test('revocation before activation consumes credential and never resurrects gym access', async () => {
  const token = await login(); const result = await provision(token);
  assert.equal((await send('post', path()+'/revoke', token, {})).status, 200);
  error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
  assert.equal((await models.GymAccess.findOne({ userId: result.userId, gymId: gymA._id })).status, 'inactive');
  assert.equal((await models.UserAccount.findById(result.userId).select('+passwordHash')).passwordHash, undefined);
  error(await send('post', path(), token, input()), 409, 'MEMBER_ACCOUNT_ALREADY_PROVISIONED');
});
for (const condition of ['inactive member', 'suspended member', 'inactive gym', 'inactive account', 'suspended account', 'missing account', 'inactive access', 'wrong role'])
  test(`${condition} prevents activation without consuming the credential or restoring state`, async () => {
    const result = await provision(await login());
    if (condition.endsWith('member')) await models.MemberProfile.updateOne({ _id: memberA._id }, { status: condition.split(' ')[0] });
    else if (condition.endsWith('gym')) await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
    else if (condition === 'missing account') await models.UserAccount.deleteOne({ _id: result.userId });
    else if (condition.endsWith('account')) await models.UserAccount.updateOne({ _id: result.userId }, { status: condition.split(' ')[0] });
    else await models.GymAccess.updateOne({ userId: result.userId }, condition === 'wrong role' ? { role: 'admin' } : { status: 'inactive' });
    error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
    assert.equal((await models.MemberActivation.findOne()).usedAt, null);
    const user = await models.UserAccount.findById(result.userId).select('+passwordHash'); assert.ok(!user?.passwordHash);
  });
test('revocation preserves global identity, member and other-gym access and sessions', async () => {
  const adminToken = await login(); const result = await provision(adminToken); await activate(result.activationToken);
  await models.GymAccess.create({ userId: result.userId, gymId: gymB._id, role: 'admin', status: 'active' });
  const loginResponse = await send('post', '/api/v1/auth/login', undefined, { email: result.email, password, client: 'mobile' }); assert.equal(loginResponse.status, 200);
  const token = loginResponse.body.data.accessToken;
  assert.equal((await send('get', `/api/v1/gyms/${gymB._id}/trainers`, token)).status, 200);
  const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
  const user = await models.UserAccount.findById(result.userId).lean(); const session = await models.AuthSession.findOne({ userId: result.userId }).lean();
  await createAuthorizationService(models).requireGymAccess({ user, session }, String(gymA._id));
  const identity = await models.UserAccount.findById(result.userId).select('+passwordHash').lean(); const originalMember = await models.MemberProfile.findById(memberA._id).lean();
  assert.equal((await send('post', path()+'/revoke', adminToken, {})).status, 200);
  await assert.rejects(createAuthorizationService(models).requireGymAccess({ user, session }, String(gymA._id)), { code: 'FORBIDDEN' });
  assert.deepEqual(await models.UserAccount.findById(result.userId).select('+passwordHash').lean(), identity);
  const after = await models.MemberProfile.findById(memberA._id).lean(); delete after.__v; delete originalMember.__v; assert.deepEqual(after, originalMember);
  assert.equal((await send('get', `/api/v1/gyms/${gymB._id}/trainers`, token)).status, 200);
  assert.equal((await send('get', '/api/v1/auth/me', token)).status, 200); assert.equal((await models.AuthSession.findById(session._id)).status, 'active');
  assert.equal((await send('post', '/api/v1/auth/refresh', undefined, { refreshToken: loginResponse.body.data.refreshToken })).status, 200);
  assert.equal((await send('post', path()+'/revoke', adminToken, {})).status, 200);
});
test('provisioning rollback never leaves accounts, access, links or credentials', async (t) => {
  const token = await login();
  for (const [model, method] of [[models.MemberProfile, 'updateOne'], [models.GymAccess, 'create'], [models.MemberActivation, 'create']]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private database failure'); });
    const response = await send('post', path(), token, input()); error(response, 500, 'INTERNAL_SERVER_ERROR'); mock.mock.restore();
    assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments(), 3);
    assert.equal((await models.MemberProfile.findById(memberA._id)).userId, undefined); assert.equal(await models.MemberActivation.countDocuments(), 0);
  }
});
test('password write failure rolls back consumed credential and activation access writes', async (t) => {
  const result = await provision(await login()); const mock = t.mock.method(models.UserAccount, 'findOneAndUpdate', () => { throw new Error('private hash update'); });
  error(await activate(result.activationToken), 500, 'INTERNAL_SERVER_ERROR'); mock.mock.restore();
  assert.equal((await models.MemberActivation.findOne()).usedAt, null);
  assert.equal((await models.UserAccount.findById(result.userId).select('+passwordHash')).passwordHash, undefined);
  assert.equal((await activate(result.activationToken)).status, 200);
});
test('token write failure cannot create a password and commit failure rolls both writes back', async (t) => {
  const result = await provision(await login());
  const mock = t.mock.method(models.MemberActivation, 'findOneAndUpdate', () => { throw new Error('private token update'); });
  error(await activate(result.activationToken), 500, 'INTERNAL_SERVER_ERROR'); mock.mock.restore();
  const start = models.MemberProfile.db.startSession.bind(models.MemberProfile.db);
  t.mock.method(models.MemberProfile.db, 'startSession', async () => {
    const session = await start(); const withTransaction = session.withTransaction.bind(session);
    session.withTransaction = (work, options) => withTransaction(async () => { await work(); throw new Error('failure before commit'); }, options);
    return session;
  });
  error(await activate(result.activationToken), 500, 'INTERNAL_SERVER_ERROR');
  assert.equal((await models.MemberActivation.findOne()).usedAt, null);
  assert.equal((await models.UserAccount.findById(result.userId).select('+passwordHash')).passwordHash, undefined);
});
test('provision/revoke and activation/revoke races never restore revoked access', async () => {
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input()), send('post', path()+'/revoke', token, {})]);
  const created = responses[0]; assert.equal(created.status, 201); assert.ok([200, 404].includes(responses[1].status));
  const result = created.body.data;
  const next = await Promise.all([activate(result.activationToken), send('post', path()+'/revoke', token, {})]);
  assert.ok([200, 401].includes(next[0].status)); assert.equal(next[1].status, 200);
  assert.equal((await models.GymAccess.findOne({ userId: result.userId, gymId: gymA._id })).status, 'inactive');
  error(await activate(result.activationToken), 401, 'INVALID_ACTIVATION_CREDENTIAL');
});
test('security events occur post-commit and contain no credentials; HTTP logs omit request secrets', async () => {
  const { Writable } = require('node:stream'); const logs = [];
  const destination = new Writable({ write(chunk, _encoding, callback) { logs.push(JSON.parse(chunk.toString())); callback(); } });
  const logger = createLogger({ ...config, logLevel: 'info' }, destination); app = createApp({ config, database, logger });
  const token = await login(); const result = await provision(token); await activate(result.activationToken);
  await send('post', path()+'/revoke', token, {});
  const events = logs.filter((record) => record.event?.startsWith('member.'));
  assert.deepEqual(events.map((record) => record.event), ['member.account_provisioned', 'member.account_activated', 'member.gym_access_revoked']);
  const serialized = JSON.stringify(logs); for (const secret of [result.activationToken, password, token, passwordHash]) assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(createHash('sha256').update(result.activationToken).digest('hex')));
  await new Promise((resolve, reject) => logger.flush((failure) => failure ? reject(failure) : resolve()));
});
test('activation attempts are rate limited through the existing auth limiter', async () => {
  for (let i = 0; i < 20; i++) error(await send('post', '/api/v1/account/activate', undefined, { token: 'bad', password }), 400, 'VALIDATION_ERROR');
  error(await activate(randomBytes(32).toString('base64url')), 429, 'RATE_LIMITED');
});
test('service rejects missing/stale admin scope and bootstrap provides no anonymous bypass', async () => {
  await login(); const { auth, authorization } = await context();
  const operations = [(scope) => service().get(auth, scope, String(memberA._id)), (scope) => service().provision(auth, scope, String(memberA._id), input()),
    (scope) => service().revoke(auth, scope, String(memberA._id))];
  for (const operation of operations) await assert.rejects(operation(undefined), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { status: 'inactive' });
  for (const operation of operations) await assert.rejects(operation(authorization), { code: 'FORBIDDEN' });
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
});
test('real standalone storage returns 503 without partial provisioning or activation', async () => {
  const mongo = await startTestMongo(); const standaloneConfig = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  const db = createDatabase({ logger: createLogger(standaloneConfig) });
  try {
    await db.connect(standaloneConfig); const application = createApp({ config: standaloneConfig, database: db }); const m = db.connection.models;
    await Promise.all(Object.values(m).map((model) => model.createIndexes()));
    const gym = await m.Gym.create({ name: 'Standalone', nameKey: 'standalone', status: 'active' });
    const user = await m.UserAccount.create({ email: 'admin@example.com', status: 'active', passwordHash });
    await m.GymAccess.create({ userId: user._id, gymId: gym._id, role: 'admin', status: 'active' });
    const person = await m.MemberProfile.create({ gymId: gym._id, memberCode: 'ME01', firstName: 'Alex', lastName: 'River', phone: '9876543210' });
    const loginResponse = await request(application).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' });
    const response = await request(application).post(`/api/v1/gyms/${gym._id}/members/${person._id}/account`).set('Authorization', `Bearer ${loginResponse.body.data.accessToken}`).send(input());
    error(response, 503, 'MEMBER_ACCOUNT_STORAGE_UNAVAILABLE'); assert.equal(await m.UserAccount.countDocuments(), 1); assert.equal(await m.GymAccess.countDocuments(), 1);
    assert.equal((await m.MemberProfile.findById(person._id)).userId, undefined);
    const raw = randomBytes(32).toString('base64url'); await m.MemberActivation.create({ userId: user._id, gymId: gym._id, memberId: person._id,
      tokenDigest: createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 60000) });
    error(await request(application).post('/api/v1/account/activate').send({ token: raw, password }), 503, 'MEMBER_ACCOUNT_STORAGE_UNAVAILABLE');
    assert.equal((await m.MemberActivation.findOne()).usedAt, null);
  } finally { await db.disconnect(); await mongo.stop(); }
});
test('startup adds activation security indexes without dropping unrelated indexes', async () => {
  await models.MemberActivation.collection.dropIndexes(); await models.MemberActivation.collection.createIndex({ usedAt: 1 }, { name: 'retained_activation_index' });
  const lifecycle = await startServer({ config: { ...config, port: 0 }, database: createDatabase({ logger: createLogger(config) }) });
  try {
    const indexes = await models.MemberActivation.listIndexes();
    assert.equal(indexes.find((index) => index.name === 'member_activation_digest_unique').unique, true);
    assert.equal(indexes.find((index) => index.name === 'member_activation_expiry').expireAfterSeconds, 0);
    assert.ok(indexes.some((index) => index.name === 'retained_activation_index'));
  } finally { await lifecycle.shutdown('test'); }
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
  const address = { line1: '123 Test Road', city: 'Test City', countryCode: 'IN' };
  await models.Branch.create({ gymId: gymA._id, name: 'Branch A', nameKey: 'branch a', address });
  await models.Branch.create({ gymId: gymB._id, name: 'Branch B', nameKey: 'branch b', address });
  const person = { firstName: 'Alex', lastName: 'River', phone: '9876543210' };
  await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR01', userId: trainer._id });
  await models.TrainerProfile.create({ ...person, gymId: gymA._id, trainerCode: 'TR02' });
  memberA = await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME01' });
  await models.MemberProfile.create({ ...person, gymId: gymA._id, memberCode: 'ME02' });
  await models.TrainerProfile.create({ ...person, gymId: gymB._id, trainerCode: 'TR01' });
  memberB = await models.MemberProfile.create({ ...person, gymId: gymB._id, memberCode: 'ME01' });
});
