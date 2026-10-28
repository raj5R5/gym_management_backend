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
const { createDeletionFulfillmentService } = require('../../src/modules/accountDeletion/fulfillment.service');
const { createOwnerProfileService } = require('../../src/modules/ownerProfile/profile.service');
let mongo, database, models, config, app, owner, other, gym, receipt, profile, service, hash, oldToken;
const password = randomBytes(24).toString('base64url');
// Synthetic evidence only; no actual operational retention or response period approved.
const evidence = () => ({ identityRef: 'isolated/identity-proof', retentionRef: 'isolated/approved-case-retention',
  ownershipRef: 'isolated/shared-owner-consent', backupRef: 'isolated/no-external-backups',
  retainedCategories: ['financial_records', 'membership_transactions', 'minimal_security_audit', 'pseudonymous_account_link']
    .map((category) => ({ category, purpose: 'Synthetic integrity test only', criteria: 'Destroy the owned test database after the test suite' })) });
const completion = { notificationRef: 'isolated/confirmed-outcome-notice', offAppRef: 'isolated/no-device-or-provider-copies' };
const id = () => String(receipt._id);
before(async () => {
  await initializePasswords(); hash = await hashPassword(password); mongo = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
});
after(async () => { try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  app = createApp({ config, database });
  owner = await models.UserAccount.create({ email: 'synthetic-delete@example.test', displayName: 'Synthetic Owner', passwordHash: hash, status: 'active' });
  other = await models.UserAccount.create({ email: 'synthetic-other@example.test', passwordHash: hash, status: 'active' });
  gym = await models.Gym.create({ name: 'Synthetic Shared Gym', nameKey: 'synthetic shared gym', status: 'active' });
  await models.GymAccess.create([{ userId: owner._id, gymId: gym._id, role: 'admin', status: 'active' },
    { userId: other._id, gymId: gym._id, role: 'admin', status: 'active' }]);
  profile = await models.OwnerProfile.create({ userId: owner._id, gymId: gym._id, phone: '9876543210' });
  oldToken = (await request(app).post('/api/v1/auth/login').send({ email: owner.email, password, client: 'mobile' })).body.data.accessToken;
  receipt = await models.AccountDeletionRequest.create({ userId: owner._id, status: 'requested', requestedAt: new Date() });
  service = createDeletionFulfillmentService({ models, enabled: true, reviewer: 'Raj' });
});
test('internal fulfillment is disabled by default and rejects an unassigned reviewer', async () => {
  const disabled = createDeletionFulfillmentService({ models });
  await assert.rejects(disabled.review('Raj', id(), evidence()), { code: 'DELETION_REVIEW_FORBIDDEN' });
  await assert.rejects(service.review('Someone else', id(), evidence()), { code: 'DELETION_REVIEW_FORBIDDEN' });
  assert.equal((await models.AccountDeletionRequest.findById(id())).status, 'requested');
});
test('review requires identity, retention, ownership and backup evidence; cannot skip to completion', async () => {
  await assert.rejects(service.review('Raj', id(), {}), { code: 'DELETION_REVIEW_INVALID' });
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_REVIEW_INVALID' });
  await assert.rejects(service.complete('Raj', id(), completion), { code: 'DELETION_REVIEW_INVALID' });
  assert.deepEqual(await service.review('Raj', id(), evidence()), { stage: 'reviewed' });
  assert.equal((await models.AccountDeletionRequest.findById(id())).status, 'in_review');
});
test('sole owner blocks fulfillment without deactivating anyone or changing money', async () => {
  await models.GymAccess.deleteOne({ userId: other._id });
  await service.review('Raj', id(), evidence());
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_OWNERSHIP_HANDOFF_REQUIRED' });
  assert.equal((await models.UserAccount.findById(owner._id)).status, 'active');
  assert.equal((await models.GymAccess.findOne({ userId: owner._id })).status, 'active');
});
test('another admin without an active account/provisioned password is not a valid handoff', async () => {
  await models.UserAccount.updateOne({ _id: other._id }, { $unset: { passwordHash: '' } });
  await service.review('Raj', id(), evidence());
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_OWNERSHIP_HANDOFF_REQUIRED' });
});
test('changed identity/grants/photo scope requires a fresh review', async () => {
  await service.review('Raj', id(), evidence());
  await models.OwnerProfile.updateOne({ _id: profile._id }, { $inc: { photoRevision: 1 } });
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_SCOPE_CHANGED' });
  assert.equal((await models.UserAccount.findById(owner._id)).status, 'active');
});
test('linked member/trainer personal records block an unsupported broad deletion', async () => {
  await models.MemberProfile.create({ gymId: gym._id, userId: owner._id, memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Linked', phone: '9876543210', status: 'active' });
  await service.review('Raj', id(), evidence());
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_LINKED_RECORD_REVIEW_REQUIRED' });
  assert.equal(await models.MemberProfile.countDocuments(), 1);
});
test('uncertain photo operations must be reconciled before access revocation', async () => {
  await models.OwnerPhotoOperation.create({ _id: 'synthetic-operation', gymId: gym._id, memberId: profile._id,
    actorId: owner._id, kind: 'upload', digest: 'synthetic', baseRevision: 0, state: 'prepared' });
  await service.review('Raj', id(), evidence());
  await assert.rejects(service.fulfill('Raj', id()), { code: 'DELETION_PENDING_OPERATIONS' });
  assert.equal((await models.UserAccount.findById(owner._id)).status, 'active');
});
test('shared-owner fulfillment erases scoped owner fields, revokes access and preserves exact business records', async () => {
  const member = await models.MemberProfile.create({ gymId: gym._id, memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Member', phone: '9876543210', status: 'active' });
  const plan = await models.MembershipPlan.create({ gymId: gym._id, name: 'Synthetic plan', price: 10000, durationDays: 30, status: 'active' });
  const subscription = await models.MemberSubscription.create({ gymId: gym._id, memberId: member._id, membershipPlanId: plan._id,
    startDate: new Date('2026-01-01'), endDate: new Date('2026-01-31'), status: 'expired',
    planNameSnapshot: plan.name, durationDaysSnapshot: 30, pricePaiseSnapshot: 10000 });
  const payment = await models.Payment.create({ gymId: gym._id, memberId: member._id, subscriptionId: subscription._id,
    amountPaise: 4000, paymentMethod: 'cash', status: 'succeeded', paidAt: new Date('2026-01-02'), recordedByUserId: owner._id });
  const original = JSON.stringify({ member: await models.MemberProfile.findById(member._id).lean(),
    subscription: await models.MemberSubscription.findById(subscription._id).lean(), payment: await models.Payment.findById(payment._id).lean() });
  await service.review('Raj', id(), evidence());
  assert.deepEqual(await service.fulfill('Raj', id()), { stage: 'cleanup_pending' });
  assert.equal((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${oldToken}`)).status, 401);
  const deleted = await models.UserAccount.findById(owner._id).select('+passwordHash').lean();
  assert.equal(deleted.status, 'inactive'); assert.equal(deleted.passwordHash, undefined); assert.equal(deleted.displayName, undefined);
  assert.notEqual(deleted.email, owner.email); assert.equal((await models.OwnerProfile.findById(profile._id)).phone, undefined);
  assert.equal((await models.GymAccess.findOne({ userId: other._id })).status, 'active');
  assert.equal((await models.UserAccount.findById(other._id)).email, other.email);
  const after = JSON.stringify({ member: await models.MemberProfile.findById(member._id).lean(),
    subscription: await models.MemberSubscription.findById(subscription._id).lean(), payment: await models.Payment.findById(payment._id).lean() });
  assert.equal(after, original);
  assert.equal((await models.AccountDeletionRequest.findById(id())).status, 'in_review');
  await assert.rejects(service.complete('Raj', id(), { notificationRef: completion.notificationRef }), { code: 'DELETION_REVIEW_INVALID' });
  assert.deepEqual(await service.complete('Raj', id(), completion), { stage: 'completed' });
  assert.deepEqual(await service.fulfill('Raj', id()), { stage: 'completed' });
  assert.equal((await models.AccountDeletionRequest.findById(id())).status, 'completed');
});
test('provider cleanup uses the existing durable worker and completion waits through failure/retry', async () => {
  const publicId = `gym_owners/${gym._id}/${profile._id}/synthetic-photo`;
  await models.OwnerProfile.updateOne({ _id: profile._id }, { $set: { photoUrl: 'https://images.example.test/synthetic.jpg', photoPublicId: publicId } });
  await service.review('Raj', id(), evidence()); await service.fulfill('Raj', id());
  await assert.rejects(service.complete('Raj', id(), completion), { code: 'DELETION_CLEANUP_PENDING' });
  let unavailable = true; const destroyed = [];
  const photos = createOwnerProfileService({ ...models, authorizationService: {}, storage: { configured: true,
    async destroy(value) { if (unavailable) throw new Error('synthetic provider unavailable'); destroyed.push(value); } } }).photos;
  await photos.cleanup(); assert.equal(await models.OwnerPhotoCleanup.countDocuments(), 1);
  await assert.rejects(service.complete('Raj', id(), completion), { code: 'DELETION_CLEANUP_PENDING' });
  unavailable = false; await models.OwnerPhotoCleanup.updateMany({}, { $set: { after: new Date(0) } });
  await photos.cleanup(); assert.deepEqual(destroyed, [publicId]);
  assert.equal(await models.OwnerPhotoCleanup.countDocuments(), 0);
  assert.deepEqual(await service.complete('Raj', id(), completion), { stage: 'completed' });
});
test('no public account completion endpoint is exposed', async () => {
  assert.equal((await request(app).post('/api/v1/auth/account-deletion-request/complete').send({ reviewer: 'Raj' })).status, 404);
});

test('isolated operator tool refuses production, remote, unknown database and implicit access before connecting', () => {
  const { requireIsolated } = require('../../src/scripts/accountDeletionReview');
  const good = { NODE_ENV: 'test', ACCOUNT_DELETION_ISOLATED: '1', MONGO_URI: `mongodb://127.0.0.1:28001/gym_tests_${'a'.repeat(32)}?replicaSet=gym_tests` };
  assert.doesNotThrow(() => requireIsolated(good));
  for (const change of [{ NODE_ENV: 'production' }, { ACCOUNT_DELETION_ISOLATED: '' },
    { MONGO_URI: 'mongodb://production.invalid/customer_data' }, { MONGO_URI: 'mongodb://127.0.0.1:27017/real_data' }]) {
    assert.throws(() => requireIsolated({ ...good, ...change }), /ISOLATED_REHEARSAL_ONLY/);
  }
});

test('abandoned and replaced owner-photo assets are queued before operation metadata is removed', async () => {
  await models.OwnerPhotoOperation.create({ _id: 'synthetic-abandoned', gymId: gym._id, memberId: profile._id,
    actorId: owner._id, kind: 'upload', digest: 'synthetic', baseRevision: 0,
    publicId: `gym_owners/${gym._id}/${profile._id}/abandoned`, state: 'abandoned' });
  await service.review('Raj', id(), evidence()); await service.fulfill('Raj', id());
  assert.equal(await models.OwnerPhotoOperation.countDocuments(), 0);
  assert.equal(await models.OwnerPhotoCleanup.countDocuments(), 1);
  await assert.rejects(service.complete('Raj', id(), completion), { code: 'DELETION_CLEANUP_PENDING' });
});
