const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
let mongo, database, models, config, app, user, token, hash;
const password = randomBytes(24).toString('base64url');
const endpoint = '/api/v1/auth/account-deletion-request';
const body = () => ({ currentPassword: password, acknowledgement: 'REQUEST_ACCOUNT_DELETION' });
const auth = (req, value = token) => req.set('Authorization', `Bearer ${value}`);
async function login(account = user) {
  const r = await request(app).post('/api/v1/auth/login').send({ email: account.email, password, client: 'mobile' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.accessToken;
}
before(async () => {
  await initializePasswords(); hash = await hashPassword(password);
  mongo = await startTestMongo();
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
});
after(async () => { try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  app = createApp({ config, database });
  user = await models.UserAccount.create({ email: 'requester@example.test', displayName: 'Synthetic Requester', status: 'active', passwordHash: hash });
  token = await login();
});
test('protected status is null only after a valid authenticated lookup', async () => {
  assert.equal((await request(app).get(endpoint)).status, 401);
  const r = await auth(request(app).get(endpoint));
  assert.equal(r.status, 200); assert.equal(r.body.data.request, null);
  assert.equal(r.headers['cache-control'], 'no-store');
});
test('request is durable, repeatable and does not delete accounts or alter sessions/financial records', async () => {
  const results = await Promise.all([1, 2, 3].map(() => auth(request(app).post(endpoint)).send(body())));
  assert.ok(results.every((r) => r.status === 202));
  const receipt = results[0].body.data.request;
  assert.ok(results.every((r) => r.body.data.request.id === receipt.id));
  assert.equal(receipt.status, 'requested'); assert.equal(receipt.userId, String(user._id));
  assert.equal(await models.AccountDeletionRequest.countDocuments(), 1);
  assert.equal(await models.UserAccount.countDocuments(), 1);
  assert.equal(await models.Payment.countDocuments(), 0);
  assert.equal((await auth(request(app).get('/api/v1/auth/me'))).status, 200);
  assert.deepEqual((await auth(request(app).get(endpoint))).body.data.request, receipt);
  assert.equal(JSON.stringify(receipt).includes(password), false);
});
test('wrong password and missing acknowledgement cannot create a request', async () => {
  const wrong = await auth(request(app).post(endpoint)).send({ ...body(), currentPassword: 'incorrect' });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.error.code, 'ACCOUNT_DELETION_PASSWORD_INVALID');
  assert.equal((await auth(request(app).post(endpoint)).send({ currentPassword: password })).status, 400);
  assert.equal(await models.AccountDeletionRequest.countDocuments(), 0);
});
test('a supplied foreign user ID/status is rejected and accounts cannot read another request', async () => {
  const other = await models.UserAccount.create({ email: 'other@example.test', status: 'active', passwordHash: hash });
  assert.equal((await auth(request(app).post(endpoint)).send({ ...body(), userId: String(other._id) })).status, 400);
  assert.equal((await auth(request(app).post(endpoint)).send({ ...body(), status: 'completed' })).status, 400);
  await auth(request(app).post(endpoint)).send(body());
  assert.equal((await auth(request(app).get(endpoint), await login(other))).body.data.request, null);
  assert.equal((await auth(request(app).get(`${endpoint}?userId=${user._id}`), await login(other))).status, 400);
});
test('external page works without an installed app, authenticates the password and returns the same request', async () => {
  const page = await request(app).get('/account-deletion');
  assert.equal(page.status, 200); assert.match(page.text, /type="password"/);
  assert.match(page.text, /<title>MuscleDesk · Account deletion<\/title>/);
  assert.match(page.text, /<h1>MuscleDesk · Account deletion<\/h1>/);
  assert.doesNotMatch(page.text, /Gym Management/);
  assert.match(page.text, /Cannot log in\?/);
  assert.match(page.text, /href="mailto:pcterajbca7772@gmail\.com\?subject=MuscleDesk%20account%20deletion%20request"/);
  assert.match(page.text, /href="\/privacy-policy"/);
  assert.match(page.text, /Ownership must be verified/);
  assert.match(page.text, /does not automatically delete/);
  assert.match(page.text, /Do not send passwords, recovery codes/);
  assert.match(page.text, /action="\/account-deletion"/);
  assert.equal(await models.AccountDeletionRequest.countDocuments(), 0);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  const r = await request(app).post('/account-deletion').type('form').send({ email: user.email, ...body() });
  assert.equal(r.status, 202); assert.match(r.text, /Account deletion has not been carried out yet/);
  assert.match(r.text, /MuscleDesk · Account deletion/);
  assert.match(r.text, /href="\/privacy-policy"/);
  assert.match(r.text, /mailto:pcterajbca7772@gmail\.com/);
  assert.doesNotMatch(r.text, /Gym Management/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const receipt = (await auth(request(app).get(endpoint))).body.data.request;
  assert.ok(r.text.includes(receipt.id));
  assert.equal(r.text.includes(user.email), false); assert.equal(r.text.includes(password), false);
});
test('public page HEAD, stylesheet and privacy navigation are read-only and require no login', async () => {
  const head = await request(app).head('/account-deletion');
  assert.equal(head.status, 200);
  assert.equal(head.text, undefined);
  assert.equal(head.headers['cache-control'], 'no-store');
  assert.equal(head.headers['set-cookie'], undefined);
  const css = await request(app).get('/account-deletion/style.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.equal(css.headers['cache-control'], 'no-store');
  assert.match(css.text, /prefers-color-scheme:light/);
  const policy = await request(app).get('/privacy-policy');
  assert.equal(policy.status, 200);
  assert.match(policy.text, /href="\/account-deletion"/);
  assert.match(policy.text, /Effective date: October 29, 2026/);
  assert.equal(await models.AccountDeletionRequest.countDocuments(), 0);
  assert.equal(await models.UserAccount.countDocuments(), 1);
});
test('external nonexistent account and wrong password use the same generic error', async () => {
  for (const input of [{ email: 'absent@example.test', ...body() }, { email: user.email, ...body(), currentPassword: 'incorrect' }]) {
    const r = await request(app).post('/account-deletion').type('form').send(input);
    assert.equal(r.status, 401); assert.equal(r.body.error.code, 'INVALID_CREDENTIALS');
  }
  assert.equal(await models.AccountDeletionRequest.countDocuments(), 0);
});
test('inactive accounts can request deletion externally without creating a login session', async () => {
  await models.UserAccount.updateOne({ _id: user._id }, { $set: { status: 'inactive' } });
  const before = await models.AuthSession.countDocuments();
  assert.equal((await request(app).post('/account-deletion').type('form').send({ email: user.email, ...body() })).status, 202);
  assert.equal(await models.AuthSession.countDocuments(), before);
});
test('password verification is rate limited', async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await auth(request(app).post(endpoint)).send({ ...body(), currentPassword: 'incorrect' })).status, 400);
  }
  assert.equal((await auth(request(app).post(endpoint)).send(body())).status, 429);
});
test('public registration stays public after the new auth subrouter is mounted', async () => {
  // An invalid registration must reach its existing validator, never the new authentication middleware.
  const r = await request(app).post('/api/v1/auth/register-owner').send({});
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});
