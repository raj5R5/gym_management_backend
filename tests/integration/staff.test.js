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
const { initializePasswords, hashPassword, verifyPassword } = require('../../src/modules/auth/password');
const { createAuthorizationService } = require('../../src/modules/authorization/authorization.service');
const { createStaffService } = require('../../src/modules/staff/staff.service');
let isolated, database, config, models, app, gymA, gymB, admin, trainer, member, passwordHash;
const password = randomBytes(24).toString('base64url');
const suppliedPassword = randomBytes(24).toString('base64url');
const missingId = () => String(new mongoose.Types.ObjectId());
const path = (gym = gymA) => `/api/v1/gyms/${gym._id}/staff`;
const input = (overrides = {}) => ({ email: 'new.staff@example.com', displayName: 'New Staff', role: 'trainer', password: suppliedPassword, ...overrides });
function error(response, status, code) {
  assert.equal(response.status, status); assert.equal(response.body.success, false); assert.equal(response.body.error.code, code);
  assert.equal(response.body.meta.requestId, response.headers['x-request-id']);
}
function send(method, url, token, body) {
  const pending = request(app)[method](url); if (token) pending.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) pending.send(body); return pending;
}
async function login(account = admin, pass = password) {
  const response = await request(app).post('/api/v1/auth/login').send({ email: account.email, password: pass, client: 'mobile' });
  assert.equal(response.status, 200); return response.body.data.accessToken;
}
async function create(token, overrides = {}, gym = gymA) {
  const response = await send('post', path(gym), token, input(overrides)); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.data;
}
function service(logger) { return createStaffService({ ...models, authorizationService: createAuthorizationService(models), logger }); }
async function context() {
  const auth = { user: admin, session: await models.AuthSession.findOne({ userId: admin._id }).lean() };
  return { auth, authorization: await createAuthorizationService(models).requireGymAccess(auth, String(gymA._id)) };
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
after(async () => { try { if (database) await database.disconnect(); } finally { if (isolated) await isolated.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({}))); app = createApp({ config, database });
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active' });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  for (const [role, assign] of [['admin', (user) => { admin = user; }], ['trainer', (user) => { trainer = user; }], ['member', (user) => { member = user; }]]) {
    const user = await models.UserAccount.create({ email: `${role}@example.com`, displayName: role, passwordHash, status: 'active' }); assign(user);
    await models.GymAccess.create({ userId: user._id, gymId: gymA._id, role, status: 'active' });
  }
});
for (const role of ['trainer', 'admin']) test(`admin creates ${role} with normalized unique identity, password and active access`, async () => {
  const data = await create(await login(), { role, email: ' Mixed.Case+Tag@Example.com ' });
  assert.deepEqual(Object.keys(data).sort(), ['userId', 'email', 'displayName', 'gymId', 'role', 'status'].sort());
  assert.equal(data.role, role); assert.equal(data.status, 'active'); assert.equal(data.gymId, String(gymA._id));
  const user = await models.UserAccount.findById(data.userId).select('+passwordHash +normalizedEmail').lean();
  assert.equal(user.normalizedEmail, 'mixed.case+tag@example.com'); assert.equal(user.status, 'active');
  assert.ok(await verifyPassword(user.passwordHash, suppliedPassword)); assert.notEqual(user.passwordHash, suppliedPassword);
  assert.equal((await models.GymAccess.findOne({ userId: user._id, gymId: gymA._id })).role, role);
  const token = await login({ email: data.email }, suppliedPassword);
  assert.equal((await send('get', '/api/v1/auth/me', token)).status, 200);
  assert.doesNotMatch(JSON.stringify(data), /password|token|normalizedEmail|__v/i);
  assert.equal(await models.TrainerProfile.countDocuments(), 0); assert.equal(await models.MemberProfile.countDocuments(), 0);
});
for (const actor of ['trainer', 'member']) test(`${actor} denied on every staff endpoint`, async () => {
  const token = await login(actor === 'trainer' ? trainer : member);
  for (const [method, url, body] of [['post', path(), input()], ['get', path()], ['get', `${path()}/${admin._id}`], ['patch', `${path()}/${admin._id}`, { displayName: 'Changed' }]])
    error(await send(method, url, token, body), 403, 'FORBIDDEN');
});
test('anonymous denied and bootstrap does not offer alternate staff provisioning', async () => {
  error(await send('post', path(), undefined, input()), 401, 'INVALID_AUTHENTICATION');
  const bootstrap = createBootstrapApp({ config: { ...config, enableBootstrapRoutes: true }, database });
  error(await request(bootstrap).post(path()).send(input()), 401, 'INVALID_AUTHENTICATION');
});
for (const status of ['inactive', 'suspended']) test(`${status} admin access denies creation`, async () => {
  const token = await login(); await models.GymAccess.updateOne({ userId: admin._id }, { status });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
});
test('inactive gym denies creation', async () => {
  const token = await login(); await models.Gym.updateOne({ _id: gymA._id }, { status: 'inactive' });
  error(await send('post', path(), token, input()), 403, 'FORBIDDEN');
});
for (const [name, overrides] of [['invalid email', { email: 'bad' }], ['weak password', { password: 'welcome1234567890!' }],
  ['short password', { password: 'short' }], ['oversized password', { password: 'x'.repeat(129) }], ['empty name', { displayName: ' ' }],
  ['oversized name', { displayName: 'x'.repeat(121) }], ['member role', { role: 'member' }], ['unknown role', { role: 'owner' }]])
  test(`create rejects ${name}`, async () => { error(await send('post', path(), await login(), input(overrides)), 400, 'VALIDATION_ERROR'); });
test('create rejects every protected field and query operators', async () => {
  const token = await login();
  for (const field of ['status', 'gymId', 'userId', 'sessionId', 'token', 'refreshToken', 'normalizedEmail', 'passwordHash', 'createdAt', 'updatedAt', 'permissions', 'unknown', '$where'])
    error(await send('post', path(), token, input({ [field]: 'untrusted' })), 400, 'VALIDATION_ERROR');
  error(await send('post', path(), token, input({ email: { $ne: null } })), 400, 'VALIDATION_ERROR');
  assert.equal(await models.UserAccount.countDocuments(), 3);
});
test('existing global identity gets second gym access without credential/profile overwrite', async () => {
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const before = await models.UserAccount.findById(trainer._id).select('+passwordHash').lean();
  const data = await create(await login(), { email: trainer.email, displayName: 'Must not overwrite', role: 'admin' }, gymB);
  assert.equal(data.userId, String(trainer._id)); assert.equal(data.displayName, before.displayName); assert.equal(data.role, 'admin');
  assert.deepEqual(await models.UserAccount.findById(trainer._id).select('+passwordHash').lean(), before);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.equal(await models.GymAccess.countDocuments({ userId: trainer._id }), 2);
  await login(trainer); error(await request(app).post('/api/v1/auth/login').send({ email: trainer.email, password: suppliedPassword, client: 'mobile' }), 401, 'INVALID_CREDENTIALS');
});
for (const status of ['active', 'inactive', 'suspended']) test(`existing ${status} access conflicts instead of overwriting`, async () => {
  await models.GymAccess.updateOne({ userId: trainer._id }, { status });
  error(await send('post', path(), await login(), input({ email: trainer.email })), 409, 'DUPLICATE_GYM_ACCESS');
  assert.equal((await models.GymAccess.findOne({ userId: trainer._id })).status, status);
});
test('existing member access cannot be converted through staff creation', async () => {
  error(await send('post', path(), await login(), input({ email: member.email })), 409, 'DUPLICATE_GYM_ACCESS');
});
test('existing inactive global account is never implicitly activated or given a replacement password', async () => {
  const target = await models.UserAccount.create({ email: 'inactive@example.com', status: 'inactive' });
  const data = await create(await login(), { email: target.email }); assert.equal(data.status, 'active');
  const saved = await models.UserAccount.findById(target._id).select('+passwordHash').lean();
  assert.equal(saved.status, 'inactive'); assert.equal(saved.passwordHash, undefined);
});
test('concurrent duplicate creation persists exactly one identity and access', async () => {
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input()), send('post', path(), token, input())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await models.UserAccount.countDocuments({ normalizedEmail: input().email }), 1);
  const user = await models.UserAccount.findOne({ normalizedEmail: input().email }); assert.equal(await models.GymAccess.countDocuments({ userId: user._id }), 1);
});
test('access insertion failure rolls back identity and version guards', async (t) => {
  const token = await login(); const before = await models.Gym.findById(gymA._id).lean();
  t.mock.method(models.GymAccess, 'create', () => { throw new Error('private database detail'); });
  const response = await send('post', path(), token, input()); error(response, 500, 'INTERNAL_SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(response.body), /private database detail/);
  assert.equal(await models.UserAccount.countDocuments(), 3); assert.deepEqual(await models.Gym.findById(gymA._id).lean(), before);
});
test('transaction-unavailable convention is 503 with no fallback', async (t) => {
  const token = await login(); let ended = false;
  t.mock.method(models.GymAccess.db, 'startSession', async () => ({ withTransaction: async () => { const err = new Error('unsupported'); err.code = 20; throw err; }, endSession: async () => { ended = true; } }));
  error(await send('post', path(), token, input()), 503, 'STAFF_STORAGE_UNAVAILABLE');
  error(await send('patch', `${path()}/${trainer._id}`, token, { displayName: 'Change' }), 503, 'STAFF_STORAGE_UNAVAILABLE');
  assert.equal(ended, true); assert.equal(await models.UserAccount.countDocuments(), 3);
});
test('list includes only same-gym staff with bounded deterministic pagination and filters', async () => {
  const token = await login(); const created = await create(token);
  await models.UserAccount.create({ email: 'elsewhere@example.com', status: 'active' }).then((user) => models.GymAccess.create({ gymId: gymB._id, userId: user._id, role: 'trainer', status: 'active' }));
  let response = await send('get', path(), token); assert.equal(response.status, 200); assert.equal(response.body.meta.pagination.total, 3);
  assert.equal(response.body.data.some((row) => row.userId === String(member._id)), false);
  response = await send('get', path()+'?role=trainer&status=active&limit=1&page=1', token);
  assert.equal(response.body.data[0].userId, created.userId); assert.deepEqual(response.body.meta.pagination, { page: 1, limit: 1, total: 2 });
  assert.equal((await send('get', path()+'?role=trainer&limit=1&page=2', token)).body.data[0].userId, String(trainer._id));
  assert.deepEqual((await send('get', path()+'?page=10000&limit=100', token)).body.data, []);
  await models.GymAccess.updateOne({ userId: trainer._id }, { status: 'suspended' });
  assert.deepEqual((await send('get', path()+'?status=suspended', token)).body.data.map((row) => row.userId), [String(trainer._id)]);
});
test('list validation rejects unknown/search/operator fields, member role and unbounded pages', async () => {
  const token = await login();
  for (const query of ['role=member', 'role[$ne]=x', 'status=bogus', 'page=0', 'limit=101', 'page=10001', 'page=1.1', 'limit=0',
    'gymId='+gymB._id, 'search=x', 'email=x', '$where=true', 'status=active&status=inactive'])
    error(await send('get', path()+'?'+query, token), 400, 'VALIDATION_ERROR');
});
test('get requires a same-gym staff relationship and excludes missing/broken/member records', async () => {
  const token = await login(); const response = await send('get', `${path()}/${trainer._id}`, token); assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const id of [String(member._id), missingId()]) error(await send('get', `${path()}/${id}`, token), 404, 'STAFF_NOT_FOUND');
  await models.GymAccess.create({ gymId: gymA._id, userId: missingId(), role: 'trainer', status: 'active' });
  assert.equal((await send('get', path(), token)).body.meta.pagination.total, 2);
});
test('cross-gym GET/PATCH fail even for multi-gym admin and never modify foreign access', async () => {
  const target = await models.UserAccount.create({ email: 'foreign@example.com', status: 'active' });
  await models.GymAccess.create({ gymId: gymB._id, userId: target._id, role: 'trainer', status: 'active' });
  const token = await login(); error(await send('get', path(gymB), token), 403, 'FORBIDDEN');
  error(await send('get', `${path()}/${target._id}`, token), 404, 'STAFF_NOT_FOUND');
  error(await send('patch', `${path()}/${target._id}`, token, { status: 'suspended' }), 404, 'STAFF_NOT_FOUND');
  assert.equal((await models.GymAccess.findOne({ gymId: gymB._id, userId: target._id })).status, 'active');
});
test('display name is global but role/status updates affect only the selected gym', async () => {
  await models.GymAccess.create({ userId: trainer._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const token = await login(); const response = await send('patch', `${path()}/${trainer._id}`, token, { displayName: 'Renamed', role: 'admin', status: 'suspended' });
  assert.equal(response.status, 200); assert.equal(response.body.data.displayName, 'Renamed');
  assert.equal((await models.UserAccount.findById(trainer._id)).status, 'active');
  assert.equal((await models.GymAccess.findOne({ gymId: gymB._id, userId: trainer._id })).role, 'admin');
  assert.equal((await models.GymAccess.findOne({ gymId: gymB._id, userId: trainer._id })).status, 'active');
  assert.equal(await models.TrainerProfile.countDocuments(), 0); assert.equal(await models.TrainerMemberAssignment.countDocuments(), 0);
});
for (const status of ['inactive', 'suspended']) test(`staff ${status} blocks gym authorization and can be reactivated`, async () => {
  const token = await login(); const trainerToken = await login(trainer);
  assert.equal((await send('patch', `${path()}/${trainer._id}`, token, { status })).status, 200);
  error(await send('get', `/api/v1/gyms/${gymA._id}/attendance`, trainerToken), 403, 'FORBIDDEN');
  assert.equal((await send('patch', `${path()}/${trainer._id}`, token, { status: 'active' })).status, 200);
  assert.equal((await models.GymAccess.findOne({ userId: trainer._id })).status, 'active');
});
test('role changes follow live database state and have no admin bypass', async () => {
  const token = await login(); const trainerToken = await login(trainer);
  assert.equal((await send('patch', `${path()}/${trainer._id}`, token, { role: 'admin' })).status, 200);
  assert.equal((await send('get', path(), trainerToken)).status, 200);
  assert.equal((await send('patch', `${path()}/${trainer._id}`, token, { role: 'trainer' })).status, 200);
  error(await send('get', path(), trainerToken), 403, 'FORBIDDEN');
});
test('PATCH rejects protected fields, empty input and invalid role/status', async () => {
  const token = await login();
  for (const field of ['email', 'password', 'passwordHash', 'normalizedEmail', 'userId', 'gymId', 'createdAt', 'updatedAt', 'permissions', 'tokens', 'unknown'])
    error(await send('patch', `${path()}/${trainer._id}`, token, { [field]: 'untrusted' }), 400, 'VALIDATION_ERROR');
  for (const body of [{}, { role: 'member' }, { role: 'owner' }, { status: 'deleted' }, { status: { $ne: null } }, { displayName: '' }])
    error(await send('patch', `${path()}/${trainer._id}`, token, body), 400, 'VALIDATION_ERROR');
  error(await send('get', `${path()}/bad`, token), 400, 'VALIDATION_ERROR');
  error(await send('get', '/api/v1/gyms/bad/staff', token), 400, 'VALIDATION_ERROR');
  error(await send('delete', `${path()}/${trainer._id}`, token), 404, 'NOT_FOUND');
});
for (const changes of [{ role: 'trainer' }, { status: 'inactive' }, { status: 'suspended' }, { role: 'trainer', displayName: 'Must roll back' }])
  test(`last active admin protected from ${JSON.stringify(changes)}`, async () => {
    const token = await login(); const before = await models.UserAccount.findById(admin._id).lean();
    error(await send('patch', `${path()}/${admin._id}`, token, changes), 409, 'LAST_ACTIVE_ADMIN');
    assert.equal((await models.GymAccess.findOne({ userId: admin._id })).role, 'admin');
    assert.equal((await models.GymAccess.findOne({ userId: admin._id })).status, 'active');
    assert.deepEqual(await models.UserAccount.findById(admin._id).lean(), before);
  });
test('inactive global account cannot act as the remaining usable administrator', async () => {
  const backup = await models.UserAccount.create({ email: 'backup@example.com', status: 'inactive' });
  await models.GymAccess.create({ gymId: gymA._id, userId: backup._id, role: 'admin', status: 'active' });
  error(await send('patch', `${path()}/${admin._id}`, await login(), { status: 'inactive' }), 409, 'LAST_ACTIVE_ADMIN');
});
test('another usable admin permits self-demotion but the demoted token immediately loses staff access', async () => {
  const token = await login(); await create(token, { role: 'admin' });
  assert.equal((await send('patch', `${path()}/${admin._id}`, token, { role: 'trainer' })).status, 200);
  error(await send('get', path(), token), 403, 'FORBIDDEN');
});
test('concurrent self-demotions by two admins retain exactly one active administrator', async () => {
  const tokenA = await login(); const second = await create(tokenA, { role: 'admin' }); const tokenB = await login({ email: second.email }, suppliedPassword);
  const responses = await Promise.all([send('patch', `${path()}/${admin._id}`, tokenA, { role: 'trainer' }),
    send('patch', `${path()}/${second.userId}`, tokenB, { status: 'suspended' })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(await models.GymAccess.countDocuments({ gymId: gymA._id, role: 'admin', status: 'active' }), 1);
});
test('concurrent changes to different admins cannot use a stale administrator count', async () => {
  const token = await login(); const second = await create(token, { role: 'admin' });
  const responses = await Promise.all([send('patch', `${path()}/${admin._id}`, token, { status: 'inactive' }),
    send('patch', `${path()}/${second.userId}`, token, { role: 'trainer' })]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.ok(responses.some((response) => [403, 409].includes(response.status)));
  assert.equal(await models.GymAccess.countDocuments({ gymId: gymA._id, role: 'admin', status: 'active' }), 1);
});
test('service entry rejects incomplete or stale administrator scope', async () => {
  await login(); const { auth, authorization } = await context();
  for (const selected of [undefined, { ...authorization, gymId: undefined }])
    await assert.rejects(service().update(auth, selected, String(trainer._id), { status: 'inactive' }), { code: 'FORBIDDEN' });
  await models.GymAccess.updateOne({ userId: admin._id }, { role: 'trainer' });
  await assert.rejects(service().create(auth, authorization, input()), { code: 'FORBIDDEN' });
});
test('structured security events are emitted only after commit with safe identifiers', async () => {
  await login(); const { auth, authorization } = await context(); const events = [];
  const staff = service({ info: (fields) => events.push(fields) }); const data = await staff.create(auth, authorization, input());
  await staff.update(auth, authorization, data.userId, { role: 'admin', status: 'suspended' });
  assert.deepEqual(events.map((entry) => entry.event), ['staff.account_created', 'staff.role_changed', 'staff.status_changed']);
  assert.doesNotMatch(JSON.stringify(events), /password|hash|token|email|displayName/i);
  assert.equal(events[0].actorUserId, String(admin._id)); assert.equal(events[0].gymId, String(gymA._id));
  await assert.rejects(staff.update(auth, authorization, String(admin._id), { role: 'trainer' }), { code: 'LAST_ACTIVE_ADMIN' });
  assert.equal(events.length, 3);
});
test('database failures fail closed with no unsafe response or successful audit event', async (t) => {
  const token = await login();
  for (const [model, method, verb, url, body] of [[models.GymAccess, 'findOne', 'get', path()],
    [models.GymAccess, 'aggregate', 'get', path()], [models.Gym, 'findOneAndUpdate', 'patch', `${path()}/${trainer._id}`, { status: 'inactive' }],
    [models.UserAccount, 'findOneAndUpdate', 'patch', `${path()}/${trainer._id}`, { displayName: 'Change' }]]) {
    const mock = t.mock.method(model, method, () => { throw new Error('private storage credentials'); });
    const response = await send(verb, url, token, body); error(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /private storage credentials/); mock.mock.restore();
  }
  assert.equal((await models.GymAccess.findOne({ userId: trainer._id })).status, 'active');
});
test('simultaneous cross-gym email creation preserves one global identity and permits safe retry', async () => {
  await models.GymAccess.create({ userId: admin._id, gymId: gymB._id, role: 'admin', status: 'active' });
  const token = await login(); const responses = await Promise.all([send('post', path(), token, input()), send('post', path(gymB), token, input())]);
  assert.ok(responses.every((response) => [201, 409].includes(response.status)));
  assert.ok(responses.some((response) => response.status === 201));
  for (let index = 0; index < responses.length; index++) if (responses[index].status === 409) {
    assert.equal(responses[index].body.error.code, 'DUPLICATE_EMAIL'); await create(token, {}, index ? gymB : gymA);
  }
  assert.equal(await models.UserAccount.countDocuments({ normalizedEmail: input().email }), 1);
  const user = await models.UserAccount.findOne({ normalizedEmail: input().email });
  assert.equal(await models.GymAccess.countDocuments({ userId: user._id }), 2);
});
test('usable admin can suspend another admin while retaining their own administrative access', async () => {
  const token = await login(); const second = await create(token, { role: 'admin' });
  assert.equal((await send('patch', `${path()}/${second.userId}`, token, { status: 'suspended' })).status, 200);
  assert.equal(await models.GymAccess.countDocuments({ gymId: gymA._id, role: 'admin', status: 'active' }), 1);
  assert.equal((await send('get', path(), token)).status, 200);
});
test('standalone MongoDB really rejects staff transactions with 503 and no orphaned account', async () => {
  const mongo = await startTestMongo(); const standaloneConfig = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  const db = createDatabase({ logger: createLogger(standaloneConfig) });
  try {
    await db.connect(standaloneConfig); const application = createApp({ config: standaloneConfig, database: db });
    const standalone = db.connection.models; await Promise.all(Object.values(standalone).map((model) => model.createIndexes()));
    const gym = await standalone.Gym.create({ name: 'Standalone', nameKey: 'standalone', status: 'active' });
    const user = await standalone.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
    await standalone.GymAccess.create({ userId: user._id, gymId: gym._id, role: 'admin', status: 'active' });
    const logged = await request(application).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' });
    assert.equal(logged.status, 200);
    const response = await request(application).post(`/api/v1/gyms/${gym._id}/staff`).set('Authorization', `Bearer ${logged.body.data.accessToken}`).send(input());
    error(response, 503, 'STAFF_STORAGE_UNAVAILABLE');
    assert.equal(await standalone.UserAccount.countDocuments(), 1); assert.equal(await standalone.GymAccess.countDocuments(), 1);
  } finally { await db.disconnect(); await mongo.stop(); }
});
test('unprovisioned active identity cannot be the only remaining administrator', async () => {
  const backup = await models.UserAccount.create({ email: 'unprovisioned@example.com', status: 'active' });
  await models.GymAccess.create({ gymId: gymA._id, userId: backup._id, role: 'admin', status: 'active' });
  error(await send('patch', `${path()}/${admin._id}`, await login(), { role: 'trainer' }), 409, 'LAST_ACTIVE_ADMIN');
});
