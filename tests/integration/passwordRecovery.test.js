const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
const { createRecoveryService } = require('../../src/modules/passwordRecovery/recovery.service');
const { createRecoveryDelivery } = require('../../src/modules/passwordRecovery/recovery.delivery');
const { issueAccessToken } = require('../../src/modules/auth/tokens');
let mongo, database, models, config, app, user, passwordHash, delivered, notices, delivery;
const password = randomBytes(24).toString('base64url');
const nextPassword = randomBytes(24).toString('base64url');
const base = '/api/v1/auth/password-recovery';
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function login(value = password) {
  return request(app).post('/api/v1/auth/login').send({ email: user.email, password: value, client: 'mobile' });
}
async function code() {
  const response = await request(app).post(`${base}/request`).send({ email: user.email });
  assert.equal(response.status, 202);
  await app.locals.recoveryService.drain();
  assert.equal(delivered.length, 1);
  return delivered[0].token;
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  mongo = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
});
after(async () => { await app?.locals.recoveryService.drain(); try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await app?.locals.recoveryService.drain();
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  delivered = []; notices = [];
  delivery = { configured: true, async sendRecovery(value) { delivered.push(value); }, async sendChanged(value) { notices.push(value); } };
  app = createApp({ config, database, recoveryDelivery: delivery });
  user = await models.UserAccount.create({ email: 'synthetic-recovery@example.test', displayName: 'Synthetic', passwordHash, status: 'active' });
});
test('known and unknown addresses receive the same generic acceptance without credentials or cookies', async () => {
  for (const email of [user.email, 'unknown@example.test']) {
    const r = await request(app).post(`${base}/request`).send({ email });
    assert.equal(r.status, 202); assert.deepEqual(r.body.data, { accepted: true });
    assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['set-cookie'], undefined);
    assert.doesNotMatch(JSON.stringify(r.body), /token|userId|@|password/i);
  }
  await app.locals.recoveryService.drain(); assert.equal(delivered.length, 1);
  const row = await models.PasswordRecovery.findOne().lean();
  assert.equal(row._id, digest(delivered[0].token)); assert.equal(row.emailDigest, digest(user.email));
  assert.equal(Object.hasOwn(row, 'token'), false);
});
test('missing delivery fails closed for known and unknown addresses with no queued email', async () => {
  const disabled = createApp({ config, database });
  for (const email of [user.email, 'unknown@example.test']) {
    const r = await request(disabled).post(`${base}/request`).send({ email });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'PASSWORD_RECOVERY_UNAVAILABLE');
  }
  assert.equal(await models.PasswordRecovery.countDocuments(), 0);
});
test('reset consumes once, revokes access/refresh, preserves grants/financial records and permits new login', async () => {
  const old = (await login()).body.data;
  const gym = await models.Gym.create({ name: 'Synthetic Gym', nameKey: 'synthetic gym', status: 'active' });
  const grant = await models.GymAccess.create({ gymId: gym._id, userId: user._id, role: 'admin', status: 'active' });
  const token = await code();
  const r = await request(app).post(`${base}/complete`).send({ token, newPassword: nextPassword });
  assert.equal(r.status, 200); assert.deepEqual(r.body.data, { passwordChanged: true });
  assert.equal(r.headers['set-cookie'], undefined); assert.equal(r.headers['cache-control'], 'no-store');
  await app.locals.recoveryService.drain(); assert.equal(notices.length, 1);
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${old.accessToken}`)).status, 401);
  assert.equal((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: old.refreshToken })).status, 401);
  assert.equal((await login()).status, 401); assert.equal((await login(nextPassword)).status, 200);
  assert.equal((await models.GymAccess.findById(grant._id)).status, 'active');
  assert.equal(await models.Payment.countDocuments(), 0);
  assert.equal((await models.UserAccount.findById(user._id)).credentialVersion, 1);
  assert.equal((await request(app).post(`${base}/complete`).send({ token, newPassword: password })).status, 401);
});
test('wrong and expired credentials share one failure without changing the password', async () => {
  const token = await code();
  await models.PasswordRecovery.updateOne({ _id: digest(token) }, { $set: { expiresAt: new Date(0) } });
  for (const value of [token, randomBytes(32).toString('base64url')]) {
    const r = await request(app).post(`${base}/complete`).send({ token: value, newPassword: nextPassword });
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'INVALID_RECOVERY_CREDENTIAL');
  }
  assert.equal((await login()).status, 200);
});
test('changing registered email invalidates an earlier ownership proof', async () => {
  const token = await code();
  await models.UserAccount.updateOne({ _id: user._id }, { $set: { email: 'changed@example.test', normalizedEmail: 'changed@example.test' } });
  assert.equal((await request(app).post(`${base}/complete`).send({ token, newPassword: nextPassword })).status, 401);
});
test('two concurrent uses of one proof commit at most one password reset', async () => {
  const token = await code();
  const outcomes = await Promise.all([1, 2].map(() => request(app).post(`${base}/complete`).send({ token, newPassword: nextPassword })));
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 401]);
  assert.equal((await models.UserAccount.findById(user._id)).credentialVersion, 1);
});
test('a second pre-reset proof cannot be used after the credential revision changes', async () => {
  const first = await code();
  await request(app).post(`${base}/request`).send({ email: user.email }); await app.locals.recoveryService.drain();
  const second = delivered[1].token;
  assert.equal((await request(app).post(`${base}/complete`).send({ token: first, newPassword: nextPassword })).status, 200);
  assert.equal((await request(app).post(`${base}/complete`).send({ token: second, newPassword: password })).status, 401);
});
test('stale login/session created after reset cannot bypass revocation', async () => {
  const token = await code();
  assert.equal((await request(app).post(`${base}/complete`).send({ token, newPassword: nextPassword })).status, 200);
  const stale = await models.AuthSession.create({ userId: user._id, clientType: 'mobile', credentialVersion: 0,
    currentTokenHash: digest('stale'), expiresAt: new Date(Date.now() + 60000), idleExpiresAt: new Date(Date.now() + 60000), lastUsedAt: new Date() });
  const bearer = issueAccessToken(user._id, stale._id, config);
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${bearer}`)).status, 401);
});
test('per-address abuse limits apply equally to known and unknown normalized addresses', async () => {
  for (const email of [user.email, 'unknown@example.test']) {
    for (let i = 0; i < 3; i++) assert.equal((await request(app).post(`${base}/request`).send({ email: ` ${email.toUpperCase()} ` })).status, 202);
    assert.equal((await request(app).post(`${base}/request`).send({ email })).status, 429);
  }
});
test('strict bodies and password policy reject extra identity fields, short passwords and malformed codes', async () => {
  assert.equal((await request(app).post(`${base}/request`).send({ email: user.email, userId: String(user._id) })).status, 400);
  assert.equal((await request(app).post(`${base}/complete`).send({ token: randomBytes(32).toString('base64url'), newPassword: 'short' })).status, 400);
  assert.equal((await request(app).post(`${base}/complete`).send({ token: '../secret', newPassword: nextPassword })).status, 400);
});
test('SMTP failure invalidates an undelivered proof without changing generic acceptance or logging secrets', async () => {
  const warnings = [];
  const service = createRecoveryService({ ...models, delivery: { configured: true,
    async sendRecovery() { throw new Error('private SMTP recipient/token/credential'); } }, logger: { warn(value) { warnings.push(value); } } });
  service.request(user.email); await service.drain();
  assert.equal(await models.PasswordRecovery.countDocuments(), 0);
  assert.equal(warnings.length, 1); assert.doesNotMatch(warnings.join(), /private SMTP|@|credential/);
});
test('change-notification failure does not falsely roll back a committed password change', async () => {
  delivery.sendChanged = async () => { throw new Error('private mail error'); };
  const token = await code();
  assert.equal((await request(app).post(`${base}/complete`).send({ token, newPassword: nextPassword })).status, 200);
  await app.locals.recoveryService.drain(); assert.equal((await login(nextPassword)).status, 200);
});
test('SMTP adapter uses TLS and no debug/file/url access without making a real provider request', async () => {
  let options, message;
  const adapter = createRecoveryDelivery({ recovery: { user: 'sender@example.test', password: 'synthetic', from: 'sender@example.test' } },
    (value) => { options = value; return { async sendMail(payload) { message = payload; } }; });
  await adapter.sendRecovery({ email: 'recipient@example.test', token: 'synthetic-proof', minutes: 15 });
  assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465); assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.debug, false); assert.equal(options.logger, false);
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
  assert.equal(message.to.address, 'recipient@example.test'); assert.ok(message.text.includes('synthetic-proof'));
  assert.equal(createRecoveryDelivery(config).configured, false);
});
