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
const { createAuthService } = require('../../src/modules/auth/auth.service');
const { createDeletionAutomation } = require('../../src/modules/accountDeletion/automation.service');
const { getDeletionJobModel } = require('../../src/modules/accountDeletion/automation.model');
const { createOwnerProfileService } = require('../../src/modules/ownerProfile/profile.service');
const { createPhotoService } = require('../../src/modules/memberPhotos/photo.service');
let mongo, database, models, config, app, authService, owner, other, gym, profile, token, otherToken, engine;
let clock, adapters, notices, alerts, destroyed, externalReady, photoFailure, notificationFailure, hash;
const password = randomBytes(24).toString('base64url'), notificationKey = randomBytes(32);
const options = () => ({ models, authService, enabled: true, notificationKey, adapters, now: () => new Date(clock) });
const later = () => { clock += 3_601_000; }; // Past the longest retry backoff.
const login = async (email) => (await request(app).post('/api/v1/auth/login').send({ email, password, client: 'mobile' })).body.data.accessToken;
const action = (kind = 'leave') => [{ gymId: String(gym._id), kind, ...(kind === 'transfer' ? { successorId: String(other._id) } : {}) }];
const preview = (kind = 'leave') => engine.preview(token, password, action(kind));
const confirm = (p, kind = 'leave') => engine.confirm(token, p.id, { token: p.token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds: kind === 'close' ? [String(gym._id)] : [] });
async function finish(p) {
  for (let i = 0; i < 8 && (await engine.status(p.id, p.statusToken)).state !== 'completed'; i++) await engine.processNext();
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'completed');
}
before(async () => {
  await initializePasswords(); hash = await hashPassword(password); mongo = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); getDeletionJobModel(database.connection); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
});
after(async () => { try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  app = createApp({ config, database });
  authService = createAuthService({ ...models, config, logger: createLogger(config) });
  owner = await models.UserAccount.create({ email: 'automation-owner@example.test', displayName: 'Synthetic Owner', passwordHash: hash, status: 'active' });
  other = await models.UserAccount.create({ email: 'automation-other@example.test', passwordHash: hash, status: 'active' });
  gym = await models.Gym.create({ name: 'Synthetic Gym', nameKey: 'synthetic gym', status: 'active', contact: { email: owner.email, phone: '9876543210' } });
  await models.GymAccess.create([{ gymId: gym._id, userId: owner._id, role: 'admin', status: 'active' },
    { gymId: gym._id, userId: other._id, role: 'admin', status: 'active' }]);
  profile = await models.OwnerProfile.create({ gymId: gym._id, userId: owner._id, phone: '9876543210' });
  token = await login(owner.email); otherToken = await login(other.email);
  clock = Date.now(); notices = []; alerts = []; destroyed = []; externalReady = true; photoFailure = false; notificationFailure = false;
  const storage = { configured: true, async destroy(id) { if (photoFailure) throw new Error('synthetic provider error'); destroyed.push(id); } };
  const ownerPhotos = createOwnerProfileService({ ...models, storage, authorizationService: {} }).photos;
  const memberPhotos = createPhotoService({ MemberProfile: models.MemberProfile, PhotoOperation: models.MemberPhotoOperation,
    PhotoCleanup: models.MemberPhotoCleanup, authorizationService: {}, storage, now: () => new Date(clock) });
  adapters = {
    async cleanupPhotos() { await ownerPhotos.cleanup(); await memberPhotos.cleanup(); },
    // Explicitly synthetic provider evidence. No production adapter or human contract exists.
    async externalStatus() { return { complete: externalReady, evidenceRef: 'fixture/no-external-copies' }; },
    async notify(message) { if (notificationFailure) throw new Error('synthetic mail failure');
      if (!notices.some((n) => n.idempotencyKey === message.idempotencyKey)) notices.push(message);
      return { evidenceRef: 'fixture/notification-accepted' }; },
    async escalate(event) { alerts.push(event); },
  };
  engine = createDeletionAutomation(options());
});
test('automation is disabled by default and requires a notice key and real adapters', () => {
  assert.throws(() => createDeletionAutomation({ ...options(), enabled: undefined }), { code: 'DELETION_AUTOMATION_DISABLED' });
  assert.throws(() => createDeletionAutomation({ ...options(), adapters: {} }), { code: 'DELETION_ADAPTERS_REQUIRED' });
  assert.throws(() => createDeletionAutomation({ ...options(), notificationKey: null }), { code: 'DELETION_KEY_REQUIRED' });
});
test('public app has no automation endpoint; forged identity and wrong password never create jobs', async () => {
  assert.equal((await request(app).post('/api/v1/auth/account-deletion/confirm').send({})).status, 404);
  await assert.rejects(engine.preview('forged', password, action()), { code: 'INVALID_AUTHENTICATION' });
  await assert.rejects(engine.preview(token, 'wrong-password', action()), { code: 'DELETION_PASSWORD_INVALID' });
  assert.equal(await models.DeletionJob.countDocuments(), 0);
});
test('preview discloses consequences without deleting; raw proofs and email are not stored', async () => {
  const p = await preview(); assert.match(p.consequences, /No gym is closed/);
  assert.match(p.gyms[0].consequences, /Other active owners/);
  const raw = await models.DeletionJob.collection.findOne({ _id: new models.UserAccount.base.Types.ObjectId(p.id) });
  const text = JSON.stringify(raw); assert.ok(!text.includes(p.token)); assert.ok(!text.includes(p.statusToken)); assert.ok(!text.includes(owner.email));
  assert.equal(await models.UserAccount.countDocuments(), 2);
  assert.equal(await engine.processNext(), false);
  await assert.rejects(engine.status(p.id, randomBytes(32).toString('base64url')), { code: 'FORBIDDEN' });
});
test('confirmation requires owner, valid unexpired proof, exact acknowledgement and unchanged scope', async () => {
  const p = await preview();
  await assert.rejects(engine.confirm(otherToken, p.id, { token: p.token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds: [] }), { code: 'DELETION_CONFIRMATION_INVALID' });
  await assert.rejects(engine.confirm(token, p.id, { token: p.token, acknowledgement: 'yes', closeGymIds: [] }), { code: 'VALIDATION_ERROR' });
  clock += 16 * 60_000;
  await assert.rejects(confirm(p), { code: 'DELETION_CONFIRMATION_INVALID' });
  clock = Date.now(); const fresh = await preview();
  await models.OwnerProfile.updateOne({ _id: profile._id }, { $set: { phone: '9876543211' } });
  await assert.rejects(confirm(fresh), { code: 'DELETION_SCOPE_CHANGED' });
  assert.equal((await models.UserAccount.findById(owner._id)).status, 'active');
});
test('duplicate confirmations and workers create one job; restart resumes; shared records and other owner survive', async () => {
  const member = await models.MemberProfile.create({ gymId: gym._id, memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Member', phone: '9876543210' });
  const before = await models.MemberProfile.findById(member._id).lean();
  const p = await preview(); const receipts = await Promise.all([confirm(p), confirm(p)]);
  assert.equal(receipts[0].id, receipts[1].id); assert.equal(await models.DeletionJob.countDocuments(), 1);
  await Promise.all([engine.processNext(), createDeletionAutomation(options()).processNext()]);
  engine = createDeletionAutomation(options());
  await finish(p);
  assert.equal(await models.UserAccount.findById(owner._id), null);
  assert.equal(await models.OwnerProfile.countDocuments(), 0);
  assert.equal(await models.AuthSession.countDocuments({ userId: owner._id }), 0);
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status, 401);
  assert.equal((await models.UserAccount.findById(other._id)).email, other.email);
  assert.deepEqual(await models.MemberProfile.findById(member._id).lean(), before);
  assert.equal((await models.Gym.findById(gym._id)).contact?.email, undefined);
  assert.equal(notices.length, 1);
  // The retained completion record holds no email or proof, only ids, times and evidence references.
  const job = await models.DeletionJob.findById(p.id).select('+notificationCiphertext +confirmationDigest').lean();
  assert.equal(job.notificationCiphertext, undefined); assert.equal(job.confirmationDigest, undefined);
  assert.ok(!JSON.stringify(job).includes(owner.email));
  assert.equal((await models.AccountDeletionRequest.findOne({ userId: owner._id })).status, 'completed');
});
test('sole owner needs a selected closure or an accepted handoff to an authorized successor', async () => {
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { role: 'trainer' } });
  await assert.rejects(preview(), { code: 'DELETION_OWNERSHIP_HANDOFF_REQUIRED' });
  const p = await preview('transfer');
  await assert.rejects(confirm(p), { code: 'DELETION_HANDOFF_ACCEPTANCE_REQUIRED' });
  await assert.rejects(engine.acceptTransfer(token, password, p.id, String(gym._id)), { code: 'FORBIDDEN' });
  await engine.acceptTransfer(otherToken, password, p.id, String(gym._id));
  await confirm(p); await finish(p);
  assert.equal((await models.GymAccess.findOne({ userId: other._id, gymId: gym._id })).role, 'admin');
  assert.ok(await models.Gym.findById(gym._id));
});
test('successor credential changes invalidate accepted handoff without deleting owner', async () => {
  const p = await preview('transfer'); await engine.acceptTransfer(otherToken, password, p.id, String(gym._id));
  await models.UserAccount.updateOne({ _id: other._id }, { $inc: { credentialVersion: 1 } });
  await assert.rejects(confirm(p), { code: 'DELETION_SCOPE_CHANGED' });
  assert.ok(await models.UserAccount.findById(owner._id));
});
test('explicit eligible gym closure removes only its records and queues member photos', async () => {
  await models.GymAccess.deleteOne({ userId: other._id });
  const foreignGym = await models.Gym.create({ name: 'Unrelated', nameKey: 'unrelated', status: 'active' });
  const member = await models.MemberProfile.create({ gymId: gym._id, memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Member', phone: '9876543210',
    photoPublicId: 'synthetic/member/photo', photoUrl: 'https://photo.invalid/synthetic.jpg' });
  const p = await preview('close'); assert.match(p.gyms[0].consequences, /Permanently delete/);
  await assert.rejects(confirm(p), { code: 'DELETION_CLOSURE_CONFIRMATION_REQUIRED' });
  await confirm(p, 'close'); await finish(p);
  assert.equal(await models.Gym.findById(gym._id), null); assert.equal(await models.MemberProfile.findById(member._id), null);
  assert.ok(await models.Gym.findById(foreignGym._id)); assert.ok(await models.UserAccount.findById(other._id));
  assert.deepEqual(destroyed, ['synthetic/member/photo']);
});
async function financialHistory(targetGym = gym) {
  const member = await models.MemberProfile.create({ gymId: targetGym._id, memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Member', phone: '9876543210' });
  const plan = await models.MembershipPlan.create({ gymId: targetGym._id, name: 'Synthetic Plan', price: 10000, durationDays: 30, status: 'active' });
  const subscription = await models.MemberSubscription.create({ gymId: targetGym._id, memberId: member._id, membershipPlanId: plan._id,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'), status: 'expired', planNameSnapshot: plan.name,
    durationDaysSnapshot: 30, pricePaiseSnapshot: 10000 });
  const payment = await models.Payment.create({ gymId: targetGym._id, memberId: member._id, subscriptionId: subscription._id, amountPaise: 10000,
    paymentMethod: 'cash', paidAt: new Date('2026-01-02'), recordedByUserId: owner._id,
    idempotencyKeyDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64) });
  return { member, plan, subscription, payment };
}
test('closure is refused while other owners run the gym; nothing is deleted', async () => {
  await assert.rejects(preview('close'), { code: 'DELETION_OTHER_OWNERS_PRESENT' });
  assert.ok(await models.Gym.findById(gym._id)); assert.equal(await models.GymAccess.countDocuments(), 2);
});
test('confirmed closure purges financial history and legacy rows; staff accounts survive without access', async () => {
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { role: 'trainer' } });
  const { member } = await financialHistory();
  await models.TrainerProfile.create({ gymId: gym._id, userId: other._id, trainerCode: 'TR01', firstName: 'Synthetic', lastName: 'Trainer', phone: '9876543219' });
  await models.Gym.db.collection('attendances').insertOne({ gymId: gym._id, memberId: member._id, checkInAt: new Date() });
  const p = await preview('close');
  assert.deepEqual({ members: p.gyms[0].counts.MemberProfile, payments: p.gyms[0].counts.Payment }, { members: 1, payments: 1 });
  await confirm(p, 'close');
  await engine.processNext(); // Erase account and revoke all gym access.
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'purge');
  assert.equal(await models.GymAccess.countDocuments({ gymId: gym._id }), 0);
  const original = models.Payment.deleteMany;
  models.Payment.deleteMany = () => { throw new Error('fixture storage failure'); };
  try { await engine.processNext(); } finally { models.Payment.deleteMany = original; }
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'purge'); assert.equal(notices.length, 0);
  later(); await finish(p);
  for (const name of ['Gym', 'MemberProfile', 'TrainerProfile', 'MembershipPlan', 'MemberSubscription', 'Payment']) {
    assert.equal(await models[name].countDocuments(), 0, name);
  }
  assert.equal(await models.Gym.db.collection('attendances').countDocuments({ gymId: gym._id }), 0);
  assert.ok(await models.UserAccount.findById(other._id)); assert.equal(await models.GymAccess.countDocuments({ userId: other._id }), 0);
  assert.equal(notices.length, 1); assert.equal(notices[0].closedGyms, 1);
});
test('leaving a shared gym keeps its payments, unlinked from the deleted login', async () => {
  const { payment } = await financialHistory();
  await models.RenewalOperation.create({ gymId: gym._id, userId: owner._id, subscriptionId: payment.subscriptionId,
    keyDigest: 'c'.repeat(64), requestDigest: 'd'.repeat(64), resultJson: '{}' });
  const p = await preview(); await confirm(p); await finish(p);
  const kept = await models.Payment.findById(payment._id).lean();
  assert.equal(kept.amountPaise, 10000); assert.equal(kept.recordedByUserId, undefined); assert.equal(kept.idempotencyKeyDigest, undefined);
  assert.equal(await models.RenewalOperation.countDocuments(), 0);
  assert.equal(await models.MemberSubscription.countDocuments(), 1); assert.ok(await models.Gym.findById(gym._id));
});
test('a member login is deleted while the gym keeps its member record, unlinked', async () => {
  const member = await models.MemberProfile.create({ userId: other._id, gymId: gym._id, memberCode: 'SYN02', firstName: 'Synthetic', lastName: 'Linked', phone: '9876543211' });
  await models.GymAccess.updateOne({ userId: other._id }, { $set: { role: 'member' } });
  const p = await engine.preview(otherToken, password, [{ gymId: String(gym._id), kind: 'leave' }]);
  await assert.rejects(engine.preview(otherToken, password, [{ gymId: String(gym._id), kind: 'close' }]), { code: 'DELETION_SCOPE_INVALID' });
  const fresh = await engine.preview(otherToken, password, [{ gymId: String(gym._id), kind: 'leave' }]);
  assert.notEqual(fresh.token, p.token);
  await engine.confirm(otherToken, fresh.id, { token: fresh.token, acknowledgement: 'DELETE_MY_ACCOUNT', closeGymIds: [] }); await finish(fresh);
  assert.equal(await models.UserAccount.findById(other._id), null);
  const kept = await models.MemberProfile.findById(member._id).lean();
  assert.equal(kept.userId, undefined); assert.equal(kept.memberCode, 'SYN02');
  assert.ok(await models.UserAccount.findById(owner._id));
});
test('pending photos and cross-gym choices fail closed', async () => {
  await assert.rejects(engine.preview(token, password, []), { code: 'DELETION_SCOPE_INVALID' });
  await assert.rejects(engine.preview(token, password, [{ gymId: String(other._id), kind: 'close' }]), { code: 'DELETION_SCOPE_INVALID' });
  await models.OwnerPhotoOperation.create({ _id: 'pending', memberId: profile._id, gymId: gym._id, actorId: owner._id,
    kind: 'upload', digest: 'fixture', baseRevision: 0, state: 'prepared' });
  await assert.rejects(preview(), { code: 'DELETION_PENDING_OPERATIONS' });
});
test('scope mutation after confirmation stops erasure and durably retries failed exception alerts', async () => {
  const p = await preview(); await confirm(p);
  await models.OwnerProfile.updateOne({ _id: profile._id }, { $set: { phone: '9876543212' } });
  adapters.escalate = async () => { throw new Error('fixture alert unavailable'); };
  await engine.processNext(); assert.equal((await engine.status(p.id, p.statusToken)).state, 'needs_action');
  assert.ok(await models.UserAccount.findById(owner._id));
  assert.equal((await models.DeletionJob.findById(p.id)).alertPending, true);
  adapters.escalate = async (event) => { alerts.push(event); }; later();
  await engine.processNext(); assert.equal((await models.DeletionJob.findById(p.id)).alertPending, false);
  assert.equal(alerts.length, 1); assert.equal(notices.length, 0);
});
test('current and abandoned owner photos retry safely; external handling and notification gate completion', async () => {
  await models.OwnerProfile.updateOne({ _id: profile._id }, { $set: { photoPublicId: 'synthetic/current', photoUrl: 'https://photo.invalid/current.jpg' } });
  await models.OwnerPhotoOperation.create({ _id: 'old', memberId: profile._id, gymId: gym._id, actorId: owner._id,
    publicId: 'synthetic/old', kind: 'upload', digest: 'fixture', baseRevision: 0, state: 'abandoned' });
  const p = await preview(); await confirm(p); await engine.processNext();
  photoFailure = true; await engine.processNext();
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'cleanup'); assert.equal(notices.length, 0);
  photoFailure = false; externalReady = false;
  await models.OwnerPhotoCleanup.updateMany({}, { $set: { after: new Date(0) } }); later();
  await engine.processNext(); assert.equal((await engine.status(p.id, p.statusToken)).reason, 'DELETION_EXTERNAL_CLEANUP_PENDING');
  assert.deepEqual(destroyed.sort(), ['synthetic/current', 'synthetic/old']);
  externalReady = true; later(); await engine.processNext();
  notificationFailure = true; await engine.processNext();
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'notifying');
  assert.notEqual((await models.AccountDeletionRequest.findOne({ userId: owner._id })).status, 'completed');
  notificationFailure = false; later(); await engine.processNext();
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'completed'); assert.equal(notices.length, 1);
});
test('expired worker lease is recovered; transaction failure rolls back all destructive writes', async () => {
  const p = await preview(); await confirm(p);
  await models.DeletionJob.updateOne({ _id: p.id }, { $set: { leaseId: 'dead-worker', leaseUntil: new Date(clock + 1000) } });
  assert.equal(await engine.processNext(), false); clock += 2000;
  const original = models.UserAccount.deleteOne;
  models.UserAccount.deleteOne = () => { throw new Error('fixture storage failure'); };
  try { await engine.processNext(); } finally { models.UserAccount.deleteOne = original; }
  assert.ok(await models.UserAccount.findById(owner._id)); assert.ok(await models.OwnerProfile.findById(profile._id));
  assert.equal((await engine.status(p.id, p.statusToken)).state, 'queued');
  later(); await finish(p);
});
