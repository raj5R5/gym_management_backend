const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const request = require('supertest');
const { requireAdultMember } = require('../../src/modules/members/member.age');
const { localDate } = require('../../src/modules/gymDashboard/dashboard.period');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
let mongo, database, models, app, config, gym, token, hash;
const password = randomBytes(24).toString('base64url');
const person = { memberCode: 'SYN01', firstName: 'Synthetic', lastName: 'Member', phone: '9876543210' };
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
  const user = await models.UserAccount.create({ email: 'synthetic-age@example.test', passwordHash: hash, status: 'active' });
  gym = await models.Gym.create({ name: 'Synthetic Age Gym', nameKey: 'synthetic age gym', status: 'active', settings: { timezone: 'Asia/Kolkata' } });
  await models.GymAccess.create({ gymId: gym._id, userId: user._id, role: 'admin', status: 'active' });
  token = (await request(app).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' })).body.data.accessToken;
});
const auth = (r) => r.set('Authorization', `Bearer ${token}`);
test('18th birthday, leap day and gym-local boundary use calendar age', () => {
  assert.throws(() => requireAdultMember('2008-10-28', '2026-10-27'), { code: 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE' });
  requireAdultMember('2008-10-27', '2026-10-27'); requireAdultMember('2008-10-26', '2026-10-27');
  assert.throws(() => requireAdultMember('2008-02-29', '2026-02-28'));
  requireAdultMember('2008-02-29', '2026-03-01');
  const instant = new Date('2026-10-26T19:00:00Z');
  requireAdultMember('2008-10-27', localDate(instant, 'Asia/Kolkata'));
  assert.throws(() => requireAdultMember('2008-10-27', localDate(instant, 'UTC')));
  requireAdultMember(null, '2026-10-27'); // Unknown is not a verified age.
});
test('all member creation paths reject a known minor before inserting financial records', async () => {
  const minor = { ...person, dateOfBirth: '2015-01-01' };
  for (const [suffix, body] of [['members', minor], ['member-onboarding', minor], ['member-onboarding/complete', { member: minor }]]) {
    const r = await auth(request(app).post(`/api/v1/gyms/${gym._id}/${suffix}`)).set('Idempotency-Key', randomUUID()).send(body);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
  }
  assert.equal(await models.MemberProfile.countDocuments(), 0);
  assert.equal(await models.Payment.countDocuments(), 0); assert.equal(await models.MemberOnboardingOperation.countDocuments(), 0);
});
test('adult and unspecified optional DOB still create with existing contracts and no mandatory photo', async () => {
  for (const dateOfBirth of ['2000-01-01', undefined]) {
    const r = await auth(request(app).post(`/api/v1/gyms/${gym._id}/members`)).send({ ...person,
      memberCode: dateOfBirth ? 'SYN01' : 'SYN02', ...(dateOfBirth ? { dateOfBirth } : {}) });
    assert.equal(r.status, 201); assert.equal(r.body.data.photoUrl, undefined);
  }
});
test('historical minors remain readable; clearing DOB cannot bypass profile-change restriction', async () => {
  const member = await models.MemberProfile.create({ ...person, dateOfBirth: new Date('2015-01-01'), gymId: gym._id, status: 'active' });
  const path = `/api/v1/gyms/${gym._id}/members/${member._id}`;
  assert.equal((await auth(request(app).get(path))).status, 200);
  for (const patch of [{ phone: '9876543211' }, { dateOfBirth: null }]) {
    const r = await auth(request(app).patch(path)).send(patch);
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
  }
  assert.equal((await models.MemberProfile.findById(member._id)).dateOfBirth.toISOString().slice(0, 10), '2015-01-01');
});

test('replacing a stored minor DOB with an adult DOB cannot bypass the profile-change restriction', async () => {
  const member = await models.MemberProfile.create({ ...person, dateOfBirth: new Date('2015-01-01'), gymId: gym._id, status: 'active' });
  const path = `/api/v1/gyms/${gym._id}/members/${member._id}`;
  const before = await models.MemberProfile.findById(member._id).lean();
  for (const patch of [{ dateOfBirth: '2000-01-01' }, { dateOfBirth: '2000-01-01', phone: '9876543211' }]) {
    const response = await auth(request(app).patch(path)).send(patch);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
    assert.deepEqual(await models.MemberProfile.findById(member._id).lean(), before);
  }
});

test('missing DOB remains optional on updates but a supplied minor DOB is rejected without partial changes', async () => {
  const member = await models.MemberProfile.create({ ...person, gymId: gym._id, status: 'active' });
  const path = `/api/v1/gyms/${gym._id}/members/${member._id}`;
  for (const patch of [{ phone: '9876543211' }, { dateOfBirth: null, firstName: 'Updated' }]) {
    const response = await auth(request(app).patch(path)).send(patch);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.dateOfBirth, undefined);
    const stored = await models.MemberProfile.findById(member._id).lean();
    assert.equal(stored.dateOfBirth, undefined);
    if (patch.phone) assert.equal(stored.phone, patch.phone);
    if (patch.firstName) assert.equal(stored.firstName, patch.firstName);
  }
  const before = await models.MemberProfile.findById(member._id).lean();
  const rejected = await auth(request(app).patch(path)).send({ dateOfBirth: '2015-01-01', phone: '9876543212' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
  assert.deepEqual(await models.MemberProfile.findById(member._id).lean(), before);
  const adult = await auth(request(app).patch(path)).send({ dateOfBirth: '2000-01-01' });
  assert.equal(adult.status, 200);
  assert.equal(adult.body.data.dateOfBirth, '2000-01-01');
  assert.equal((await models.MemberProfile.findById(member._id)).dateOfBirth.toISOString().slice(0, 10), '2000-01-01');
});

test('adult DOB updates preserve omission, adult correction and clearing while rejecting a minor replacement', async () => {
  const member = await models.MemberProfile.create({ ...person, dateOfBirth: new Date('2000-01-01'), gymId: gym._id, status: 'active' });
  const path = `/api/v1/gyms/${gym._id}/members/${member._id}`;
  const unchanged = await auth(request(app).patch(path)).send({ firstName: 'Updated' });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.data.dateOfBirth, '2000-01-01');
  const before = await models.MemberProfile.findById(member._id).lean();
  const rejected = await auth(request(app).patch(path)).send({ dateOfBirth: '2015-01-01' });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
  assert.deepEqual(await models.MemberProfile.findById(member._id).lean(), before);
  const corrected = await auth(request(app).patch(path)).send({ dateOfBirth: '2001-01-01' });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.data.dateOfBirth, '2001-01-01');
  const cleared = await auth(request(app).patch(path)).send({ dateOfBirth: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.dateOfBirth, undefined);
  assert.equal((await models.MemberProfile.findById(member._id).lean()).dateOfBirth, undefined);
});

test('known-minor photo uploads and account provisioning are blocked, while photo removal remains possible', async () => {
  const minor = await models.MemberProfile.create({ ...person, dateOfBirth: new Date('2015-01-01'), gymId: gym._id, status: 'active' });
  let uploads = 0;
  const local = createApp({ config, database, photoStorage: { configured: true, async upload() { uploads++; throw new Error('must not dispatch'); } } });
  const bytes = await require('sharp')({ create: { width: 1, height: 1, channels: 3, background: '#333333' } }).jpeg().toBuffer();
  const photoPath = `/api/v1/gyms/${gym._id}/members/${minor._id}/photo`;
  const upload = await auth(request(local).put(photoPath)).set('Idempotency-Key', randomUUID()).attach('photo', bytes, { filename: 'synthetic.jpg', contentType: 'image/jpeg' });
  assert.equal(upload.status, 409); assert.equal(upload.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE'); assert.equal(uploads, 0);
  assert.equal((await auth(request(local).delete(photoPath)).set('Idempotency-Key', randomUUID())).status, 200);
  const account = await auth(request(app).post(`/api/v1/gyms/${gym._id}/members/${minor._id}/account`)).send({ email: 'minor@example.test' });
  assert.equal(account.status, 409); assert.equal(account.body.error.code, 'MINOR_MEMBER_WORKFLOW_UNAVAILABLE');
});
test('a historical committed minor onboarding receipt can still be replayed without creating another member', async () => {
  const path = `/api/v1/gyms/${gym._id}/member-onboarding/complete`;
  const key = randomUUID(); const adult = { ...person, dateOfBirth: '2000-01-01' };
  const first = await auth(request(app).post(path)).set('Idempotency-Key', key).send({ member: adult });
  assert.equal(first.status, 201);
  const minor = { ...person, dateOfBirth: '2015-01-01' };
  const frozen = { member: Object.fromEntries(Object.keys(minor).sort().map((key) => [key, minor[key]])) };
  const requestDigest = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
  // Fixture represents an operation committed before the new policy. No live data.
  await models.MemberOnboardingOperation.collection.updateOne({}, { $set: { requestDigest } });
  const replay = await auth(request(app).post(path)).set('Idempotency-Key', key).send({ member: minor });
  assert.equal(replay.status, 201); assert.deepEqual(replay.body.data, first.body.data);
  assert.equal(await models.MemberProfile.countDocuments(), 1);
});
