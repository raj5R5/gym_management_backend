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
let mongo, database, models, config, app, sent, owner, other, gym, hash;
const password = randomBytes(24).toString('base64url');
// Synthetic delivery only; no SMTP connection is made.
const delivery = { configured: true,
  async sendRecovery() {}, async sendChanged() {},
  async sendDeletionCompleted(message) { sent.push({ kind: 'completed', ...message }); },
  async sendDeletionNeedsAction(message) { sent.push({ kind: 'needs_action', ...message }); },
  async sendDeletionOperatorAlert(message) { sent.push({ ...message, kind: 'operator_alert' }); } };
const env = (extra = {}) => ({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri,
  RECOVERY_SMTP_USER: 'sender@example.test', RECOVERY_SMTP_PASSWORD: 'synthetic', RECOVERY_EMAIL_FROM: 'sender@example.test',
  ACCOUNT_DELETION_AUTOMATION: 'enabled', ACCOUNT_DELETION_NOTICE_KEY: randomBytes(32).toString('hex'), ...extra });
const login = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password, client: 'mobile' })).body.data.accessToken;
const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
async function drain() { await app.locals.deletionWorker.drain(); }
before(async () => {
  await initializePasswords(); hash = await hashPassword(password); mongo = await startTestMongo({ replicaSet: true });
  config = loadConfig(env());
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database, recoveryDelivery: delivery }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
});
after(async () => { try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  sent = []; app = createApp({ config, database, recoveryDelivery: delivery });
  owner = await models.UserAccount.create({ email: 'route-owner@example.test', displayName: 'Synthetic Owner', passwordHash: hash, status: 'active' });
  other = await models.UserAccount.create({ email: 'route-staff@example.test', displayName: 'Synthetic Staff', passwordHash: hash, status: 'active' });
  gym = await models.Gym.create({ name: 'Synthetic <Gym>', nameKey: 'synthetic gym', status: 'active' });
  await models.GymAccess.create([{ gymId: gym._id, userId: owner._id, role: 'admin', status: 'active' },
    { gymId: gym._id, userId: other._id, role: 'trainer', status: 'active' }]);
});
test('enabling automation without a notice key or mail delivery is a configuration error', () => {
  for (const missing of ['ACCOUNT_DELETION_NOTICE_KEY', 'RECOVERY_SMTP_PASSWORD']) {
    assert.throws(() => loadConfig(env({ [missing]: '' })), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => loadConfig(env({ ACCOUNT_DELETION_NOTICE_KEY: '00'.repeat(32) })), { code: 'INVALID_CONFIGURATION' });
  assert.equal(loadConfig({ ...testAuthEnv, MONGO_URI: mongo.uri }).accountDeletion.automated, false);
});
test('app flow: options, handoff acceptance by successor, confirm, worker completion and public status', async () => {
  const token = await login(owner.email), staffToken = await login(other.email);
  assert.equal((await request(app).post('/api/v1/auth/account-deletion-request').set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: password, acknowledgement: 'REQUEST_ACCOUNT_DELETION' })).body.error.code, 'ACCOUNT_DELETION_UPDATE_REQUIRED');
  const options = (await request(app).get('/api/v1/auth/account-deletion/options').set('Authorization', `Bearer ${token}`)).body.data.gyms;
  assert.deepEqual(options[0].choices, ['close', 'transfer']); assert.equal(options[0].successors[0].userId, String(other._id));
  const choices = [{ gymId: String(gym._id), kind: 'transfer', successorId: String(other._id) }];
  assert.equal((await request(app).post('/api/v1/auth/account-deletion/preview').set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: 'wrong', choices })).body.error.code, 'DELETION_PASSWORD_INVALID');
  const preview = (await request(app).post('/api/v1/auth/account-deletion/preview').set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: password, choices })).body.data.preview;
  const confirm = () => request(app).post('/api/v1/auth/account-deletion/confirm').set('Authorization', `Bearer ${token}`)
    .send({ jobId: preview.id, token: preview.token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds: [] });
  assert.equal((await confirm()).body.error.code, 'DELETION_HANDOFF_ACCEPTANCE_REQUIRED');
  const handoffs = (await request(app).get('/api/v1/auth/account-deletion/handoffs').set('Authorization', `Bearer ${staffToken}`)).body.data.handoffs;
  assert.deepEqual(handoffs.map((h) => [h.jobId, h.accepted]), [[preview.id, false]]);
  assert.equal((await request(app).post('/api/v1/auth/account-deletion/handoffs/accept').set('Authorization', `Bearer ${staffToken}`)
    .send({ currentPassword: password, jobId: preview.id, gymId: String(gym._id) })).status, 200);
  const confirmed = await confirm(); assert.equal(confirmed.status, 202); assert.equal(confirmed.body.data.job.state, 'queued');
  await drain();
  const status = await request(app).post('/api/v1/auth/account-deletion/status').send({ id: preview.id, statusToken: preview.statusToken });
  assert.equal(status.body.data.job.state, 'completed'); assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal((await request(app).post('/api/v1/auth/account-deletion/status').send({ id: preview.id, statusToken: 'x'.repeat(43) })).status, 403);
  assert.equal((await models.GymAccess.findOne({ userId: other._id })).role, 'admin');
  assert.equal(await models.UserAccount.findById(owner._id), null);
  assert.deepEqual(sent.map((m) => [m.kind, m.email]), [['completed', owner.email]]);
});
test('web flow: review shows escaped closure summary; confirmation requires password and each closure tick', async () => {
  assert.match((await request(app).get('/account-deletion')).text, /Review what will be deleted/);
  const wrong = await request(app).post('/account-deletion/review').type('form').send({ email: owner.email, currentPassword: 'wrong' });
  assert.equal(wrong.status, 401); assert.match(wrong.text, /Nothing was deleted/);
  const review = await request(app).post('/account-deletion/review').type('form').send({ email: owner.email, currentPassword: password });
  assert.equal(review.status, 200); assert.match(review.text, /Synthetic &lt;Gym&gt;/); assert.doesNotMatch(review.text, /<Gym>/);
  const fields = { email: owner.email, jobId: hidden(review.text, 'jobId'), token: hidden(review.text, 'token'),
    statusToken: hidden(review.text, 'statusToken'), acknowledgement: 'DELETE_MY_ACCOUNT' };
  const missingTick = await request(app).post('/account-deletion/confirm').type('form').send({ ...fields, currentPassword: password });
  assert.equal(missingTick.status, 409); assert.ok(await models.UserAccount.findById(owner._id));
  const done = await request(app).post('/account-deletion/confirm').type('form').send({ ...fields, currentPassword: password, closeGymIds: String(gym._id) });
  assert.equal(done.status, 202); assert.match(done.text, /Deletion confirmed/);
  await drain();
  const status = await request(app).post('/account-deletion/status').type('form').send({ id: fields.jobId, statusToken: fields.statusToken });
  assert.match(status.text, /Deletion is complete/);
  assert.equal(await models.Gym.findById(gym._id), null); assert.ok(await models.UserAccount.findById(other._id));
});
test('a request blocked before erasure emails the requester and leaves the account usable', async () => {
  await models.GymAccess.create({ gymId: gym._id, userId: (await models.UserAccount.create({ email: 'route-third@example.test', passwordHash: hash, status: 'active' }))._id, role: 'admin', status: 'active' });
  const token = await login(owner.email);
  const preview = (await request(app).post('/api/v1/auth/account-deletion/preview').set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: password, choices: [{ gymId: String(gym._id), kind: 'leave' }] })).body.data.preview;
  await request(app).post('/api/v1/auth/account-deletion/confirm').set('Authorization', `Bearer ${token}`)
    .send({ jobId: preview.id, token: preview.token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds: [] });
  await models.GymAccess.deleteOne({ role: 'admin', userId: { $nin: [owner._id] } });
  await drain();
  assert.equal((await models.DeletionJob.findById(preview.id)).state, 'needs_action');
  assert.ok(await models.UserAccount.findById(owner._id));
  assert.deepEqual(sent.map((m) => m.kind), ['needs_action']); assert.match(sent[0].reason, /no longer has another active owner/);
});
test('operator mode: intake stays, self-service is off, reviewed requests complete only after the worker finishes', async () => {
  const operatorConfig = loadConfig(env({ ACCOUNT_DELETION_AUTOMATION: 'operator' }));
  app = createApp({ config: operatorConfig, database, recoveryDelivery: delivery });
  const token = await login(owner.email);
  assert.equal((await request(app).get('/api/v1/auth/account-deletion/options').set('Authorization', `Bearer ${token}`)).status, 404);
  assert.doesNotMatch((await request(app).get('/account-deletion')).text, /Review what will be deleted/);
  const intake = await request(app).post('/api/v1/auth/account-deletion-request').set('Authorization', `Bearer ${token}`)
    .send({ currentPassword: password, acknowledgement: 'REQUEST_ACCOUNT_DELETION' });
  assert.equal(intake.status, 202);
  const id = intake.body.data.request.id, engine = app.locals.deletionEngine;
  const review = await engine.reviewRequest(id);
  assert.equal(review.account.email, owner.email); assert.deepEqual(review.gyms[0].choices, ['close', 'transfer']);
  await assert.rejects(engine.queueRequest(id, [{ gymId: String(gym._id), kind: 'transfer', successorId: String(other._id) }]), { code: 'DELETION_SCOPE_INVALID' });
  await assert.rejects(engine.queueRequest(id, [{ gymId: String(gym._id), kind: 'leave' }]), { code: 'DELETION_OWNERSHIP_HANDOFF_REQUIRED' });
  // Handoff path: the owner promotes the staff member first, then the operator fulfils as leave.
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { role: 'admin' } });
  const job = await engine.queueRequest(id, [{ gymId: String(gym._id), kind: 'leave' }]);
  assert.equal(job.state, 'queued');
  assert.equal((await request(app).get('/api/v1/auth/account-deletion-request').set('Authorization', `Bearer ${token}`)).body.data.request.status, 'in_review');
  assert.equal((await engine.queueRequest(id, [{ gymId: String(gym._id), kind: 'leave' }])).id, job.id); // Idempotent re-run.
  await app.locals.deletionWorker.drain();
  assert.equal(await models.UserAccount.findById(owner._id), null); assert.ok(await models.Gym.findById(gym._id));
  assert.equal((await models.AccountDeletionRequest.findById(id)).status, 'completed');
  assert.deepEqual(sent.map((m) => [m.kind, m.email, m.reference]), [['completed', owner.email, id]]);
});
test('operator mode alerts the operator mailbox, not the requester, when a queued request is blocked', async () => {
  app = createApp({ config: loadConfig(env({ ACCOUNT_DELETION_AUTOMATION: 'operator' })), database, recoveryDelivery: delivery });
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { role: 'admin' } });
  const row = await models.AccountDeletionRequest.create({ userId: owner._id, status: 'requested', requestedAt: new Date() });
  await app.locals.deletionEngine.queueRequest(String(row._id), [{ gymId: String(gym._id), kind: 'leave' }]);
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { status: 'inactive' } });
  await app.locals.deletionWorker.drain();
  assert.ok(await models.UserAccount.findById(owner._id));
  assert.deepEqual(sent.map((m) => [m.kind, m.email]), [['operator_alert', 'sender@example.test']]);
  assert.equal((await models.AccountDeletionRequest.findById(row._id)).status, 'in_review');
});
test('operator CLI lists requests, dry-runs by default and requires explicit closure confirmation', async () => {
  const { run } = require('../../src/scripts/accountDeletionOperator');
  const environment = env({ ACCOUNT_DELETION_AUTOMATION: 'operator' }), lines = [];
  const out = (line) => lines.push(line);
  await run(['record-email', owner.email.toUpperCase()], environment, out);
  const id = String((await models.AccountDeletionRequest.findOne({ userId: owner._id }))._id);
  await run(['list'], environment, out);
  assert.ok(lines.some((l) => l.startsWith(id) && l.includes(owner.email)));
  const choice = `${gym._id}=close`;
  await run(['fulfill', id, choice], environment, out);
  assert.match(lines.at(-1), /Dry run only/); assert.equal(await models.DeletionJob.countDocuments(), 0);
  await assert.rejects(run(['fulfill', id, choice, '--yes'], environment, out), { code: 'USAGE' });
  await assert.rejects(run(['fulfill', id, `${gym._id}=delete`], environment, out), { code: 'USAGE' });
  await run(['fulfill', id, choice, '--yes', '--closure-confirmed'], environment, out);
  assert.match(lines.at(-1), /Queued/); assert.equal((await models.DeletionJob.findOne()).state, 'queued');
  await assert.rejects(run(['list'], env({ ACCOUNT_DELETION_AUTOMATION: 'disabled' }), out), { code: 'USAGE' });
});
