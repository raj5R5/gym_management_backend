const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const request = require('supertest');
const sharp = require('sharp');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');
let mongo, database, models, config, app, gym, otherGym, user, token, hash, image, storage;
const password = randomBytes(24).toString('base64url');
const path = () => `/api/v1/gyms/${gym._id}/owner-profile`;
const input = () => ({ displayName: 'Edited Owner', email: user.email, phone: '9876543210',
  gymName: 'Edited Gym', gymContactPhone: '9876543211', gymContactEmail: 'gym@example.test' });
const auth = (req, value = token) => req.set('Authorization', `Bearer ${value}`);
async function login(account = user, value = password) {
  const r = await request(app).post('/api/v1/auth/login').send({ email: account.email, password: value, client: 'mobile' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data.accessToken;
}
const error = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error.code, code); };
const upload = (key = randomUUID(), bytes = image) => auth(request(app).put(`${path()}/photo`))
  .set('Idempotency-Key', key).attach('photo', bytes, { filename: 'profile.jpg', contentType: 'image/jpeg' });
before(async () => {
  await initializePasswords(); hash = await hashPassword(password);
  mongo = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: mongo.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
  image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aabb33' } }).jpeg().toBuffer();
});
after(async () => { try { await database?.disconnect(); } finally { await mongo?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  storage = { configured: true, assets: new Map(), uploads: 0, fail: false,
    async upload(bytes, publicId) { this.uploads += 1; if (this.fail) throw new Error('private storage detail');
      this.assets.set(publicId, bytes); return { publicId, url: `https://res.cloudinary.com/test/${publicId}.jpg` }; },
    async read(id) { return this.assets.get(id); }, async destroy(id) { this.assets.delete(id); } };
  app = createApp({ config, database, ownerPhotoStorage: storage });
  gym = await models.Gym.create({ name: 'Original Gym', nameKey: 'original gym', status: 'active', settings: { timezone: 'Asia/Kolkata' } });
  otherGym = await models.Gym.create({ name: 'Other Gym', nameKey: 'other gym', status: 'active' });
  user = await models.UserAccount.create({ email: 'owner@example.test', displayName: 'Original Owner', status: 'active', passwordHash: hash });
  await models.GymAccess.create({ userId: user._id, gymId: gym._id, role: 'admin', status: 'active' }); token = await login();
});
test('existing owners receive accurate completion and no secret/provider fields', async () => {
  const r = await auth(request(app).get(path())); assert.equal(r.status, 200);
  assert.equal(r.body.data.displayName, 'Original Owner'); assert.equal(r.body.data.gymName, 'Original Gym');
  assert.deepEqual(r.body.data.completion, { completed: 3, total: 6 });
  assert.equal(r.headers['cache-control'], 'no-store');
  for (const field of ['passwordHash', 'normalizedEmail', 'photoPublicId', 'role']) assert.equal(r.body.data[field], undefined);
});
test('profile saves only approved fields atomically and preserves login, timezone and gym access', async () => {
  const r = await auth(request(app).patch(path())).send(input()); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.phone, '9876543210'); assert.deepEqual(r.body.data.completion, { completed: 5, total: 6 });
  assert.equal((await models.Gym.findById(gym._id)).settings.timezone, 'Asia/Kolkata');
  assert.equal((await models.GymAccess.findOne({ userId: user._id })).role, 'admin');
  assert.ok(await login()); assert.equal(await models.Payment.countDocuments(), 0);
});
test('email edits require the current password and duplicate emails roll back every field', async () => {
  error(await auth(request(app).patch(path())).send({ ...input(), email: 'new@example.test' }), 400, 'PROFILE_PASSWORD_REQUIRED');
  error(await auth(request(app).patch(path())).send({ ...input(), email: 'new@example.test', currentPassword: 'wrong' }), 400, 'PROFILE_PASSWORD_INVALID');
  assert.equal((await models.Gym.findById(gym._id)).name, 'Original Gym');
  await models.UserAccount.create({ email: 'taken@example.test', status: 'active' });
  error(await auth(request(app).patch(path())).send({ ...input(), email: 'taken@example.test', currentPassword: password }), 409, 'DUPLICATE_EMAIL');
  assert.equal((await models.Gym.findById(gym._id)).name, 'Original Gym');
  const r = await auth(request(app).patch(path())).send({ ...input(), email: 'new@example.test', currentPassword: password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await login({ email: 'new@example.test' }));
});
test('unknown security/photo fields and malformed details are rejected without changes', async () => {
  for (const extra of [{ role: 'admin' }, { status: 'inactive' }, { userId: String(user._id) }, { photoUrl: 'https://evil.test/x' }, { passwordHash: 'x' }, { gymId: String(otherGym._id) }]) {
    error(await auth(request(app).patch(path())).send({ ...input(), ...extra }), 400, 'VALIDATION_ERROR');
  }
  error(await auth(request(app).patch(path())).send({ ...input(), phone: 'abc' }), 400, 'VALIDATION_ERROR');
  assert.equal((await models.UserAccount.findById(user._id)).displayName, 'Original Owner');
});
test('unauthenticated, trainer, inactive and cross-gym requests cannot read or change profiles', async () => {
  error(await request(app).get(path()), 401, 'INVALID_AUTHENTICATION');
  error(await auth(request(app).get(path().replace(String(gym._id), String(otherGym._id)))), 403, 'FORBIDDEN');
  const access = await models.GymAccess.findOne({ userId: user._id }); access.role = 'trainer'; await access.save();
  error(await auth(request(app).get(path())), 403, 'FORBIDDEN');
  access.role = 'admin'; access.status = 'inactive'; await access.save();
  error(await auth(request(app).patch(path())).send(input()), 403, 'FORBIDDEN');
});
test('owner photos reuse durable operations, protected bytes and immutable namespace', async () => {
  const key = randomUUID(); const r = await upload(key); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.photoUrl, /owner-profile\/photo\?v=1$/); assert.equal(r.body.data.userId, String(user._id));
  assert.equal(r.body.data.photoPublicId, undefined);
  assert.equal((await upload(key)).status, 200); assert.equal(storage.uploads, 1);
  const profile = await models.OwnerProfile.findOne({ userId: user._id }); assert.match(profile.photoPublicId, /^gym_owners\//);
  const bytes = await auth(request(app).get(`${path()}/photo`)); assert.equal(bytes.status, 200); assert.ok(Buffer.isBuffer(bytes.body));
  const status = await auth(request(app).get(`${path()}/photo/operations/${key}`)); assert.equal(status.body.data.state, 'committed');
  assert.equal((await auth(request(app).get(path()))).body.data.completion.completed, 4);
  const removal = randomUUID(); assert.equal((await auth(request(app).delete(`${path()}/photo`)).set('Idempotency-Key', removal)).status, 200);
  assert.equal((await auth(request(app).delete(`${path()}/photo`)).set('Idempotency-Key', removal)).status, 200);
  error(await auth(request(app).get(`${path()}/photo`)), 404, 'PHOTO_NOT_FOUND');
  await app.locals.ownerPhotoService.cleanup(); assert.equal(storage.assets.size, 0);
  assert.equal(await models.MemberPhotoOperation.countDocuments(), 0);
});
test('another administrator sees only their own identity and photo, including operation status', async () => {
  const key = randomUUID(); await upload(key);
  const second = await models.UserAccount.create({ email: 'second@example.test', status: 'active', passwordHash: hash });
  await models.GymAccess.create({ userId: second._id, gymId: gym._id, role: 'admin', status: 'active' });
  const otherToken = await login(second);
  error(await auth(request(app).get(`${path()}/photo`), otherToken), 404, 'PHOTO_NOT_FOUND');
  const status = await auth(request(app).get(`${path()}/photo/operations/${key}`), otherToken);
  assert.equal(status.body.data.state, 'unknown'); assert.equal(status.body.data.userId, String(second._id));
  assert.equal(storage.uploads, 1);
});
test('failed replacement preserves the saved photo and never exposes provider errors', async () => {
  await upload(); const original = await models.OwnerProfile.findOne({ userId: user._id }).lean(); storage.fail = true;
  const r = await upload(); error(r, 503, 'PHOTO_STORAGE_UNAVAILABLE'); assert.equal(JSON.stringify(r.body).includes('private storage'), false);
  assert.equal((await models.OwnerProfile.findById(original._id)).photoPublicId, original.photoPublicId);
  assert.equal((await auth(request(app).get(`${path()}/photo`))).status, 200);
});
