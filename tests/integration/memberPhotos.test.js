const { test, before, after, beforeEach } = require('node:test');
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
const { MAX_PHOTO_BYTES } = require('../../src/modules/memberPhotos/photo.image');
let isolated, database, config, models, app, gym, otherGym, admin, trainer, memberUser, member, token, passwordHash, image, png, storage;
const password = randomBytes(24).toString('base64url');
const path = () => `/api/v1/gyms/${gym._id}/members/${member._id}/photo`;
const assertError = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error.code, code); };
async function login(user = admin) {
  const r = await request(app).post('/api/v1/auth/login').send({ email: user.email, password, client: 'mobile' });
  assert.equal(r.status, 200); return r.body.data.accessToken;
}
function upload({ bytes = image, type = 'image/jpeg', key = randomUUID(), auth = token, url = path() } = {}) {
  const req = request(app).put(url).set('Idempotency-Key', key);
  if (auth) req.set('Authorization', `Bearer ${auth}`);
  return req.attach('photo', bytes, { filename: 'anything.jpg', contentType: type });
}
const remove = (key = randomUUID()) => request(app).delete(path()).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key);
const getPhoto = (auth = token, url = path()) => {
  const req = request(app).get(url); if (auth) req.set('Authorization', `Bearer ${auth}`); return req;
};
function fakeStorage() {
  return { configured: true, uploads: [], deleted: [], assets: new Map(), failUpload: false, failDelete: false,
    async upload(bytes, publicId) {
      this.uploads.push(publicId); if (this.failUpload) throw new Error('private provider secret/path');
      this.assets.set(publicId, bytes); return { publicId, url: `https://res.cloudinary.com/test/image/authenticated/${publicId}.jpg` };
    },
    async read(publicId) { if (!this.assets.has(publicId)) throw new Error('missing private asset'); return this.assets.get(publicId); },
    async destroy(publicId) { if (this.failDelete) throw new Error('private deletion error'); this.deleted.push(publicId); this.assets.delete(publicId); },
  };
}
before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) }); await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((m) => m.createIndexes()));
  image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#dd8855' } }).jpeg().toBuffer();
  png = await sharp({ create: { width: 24, height: 32, channels: 4, background: '#55aa88' } }).png().toBuffer();
});
after(async () => { try { await database?.disconnect(); } finally { await isolated?.stop(); } });
beforeEach(async () => {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})));
  storage = fakeStorage(); app = createApp({ config, database, photoStorage: storage });
  gym = await models.Gym.create({ name: 'Photo Gym', nameKey: 'photo gym', status: 'active' });
  otherGym = await models.Gym.create({ name: 'Other Gym', nameKey: 'other gym', status: 'active' });
  const users = [];
  for (const role of ['admin', 'trainer', 'member']) {
    const user = await models.UserAccount.create({ email: `${role}@photo.test`, passwordHash, status: 'active' }); users.push(user);
    await models.GymAccess.create({ userId: user._id, gymId: gym._id, role, status: 'active' });
  }
  [admin, trainer, memberUser] = users;
  member = await models.MemberProfile.create({ gymId: gym._id, memberCode: 'PHOTO01', firstName: 'Photo', lastName: 'Member', phone: '9876543210' });
  token = await login();
});
test('old members have no photo; ordinary member writes cannot set provider fields', async () => {
  assertError(await getPhoto(), 404, 'PHOTO_NOT_FOUND');
  const read = await request(app).get(path().replace('/photo', '')).set('Authorization', `Bearer ${token}`);
  assert.equal(read.body.data.photoUrl, undefined);
  const patch = await request(app).patch(path().replace('/photo', '')).set('Authorization', `Bearer ${token}`)
    .send({ photoUrl: 'https://attacker.test/x', photoPublicId: 'foreign' });
  assertError(patch, 400, 'VALIDATION_ERROR'); assert.equal(storage.uploads.length, 0);
});
test('authorized upload re-encodes the image and exposes only a protected API URL everywhere', async () => {
  const r = await upload(); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.photoRevision, 1); assert.match(r.body.data.photoUrl, /\/photo\?v=1$/);
  assert.equal(r.body.data.photoPublicId, undefined);
  const saved = await models.MemberProfile.findById(member._id).lean();
  assert.match(saved.photoUrl, /^https:\/\/res.cloudinary.com\//); assert.ok(saved.photoPublicId);
  for (const url of [path().replace('/photo', ''), path().replace(`/members/${member._id}/photo`, '/members'), path().replace('/photo', '/summary')]) {
    const read = await request(app).get(url).set('Authorization', `Bearer ${token}`); assert.equal(read.status, 200, JSON.stringify(read.body));
    const profile = Array.isArray(read.body.data) ? read.body.data[0] : read.body.data.member ?? read.body.data;
    assert.equal(profile.photoUrl, r.body.data.photoUrl); assert.equal(profile.photoPublicId, undefined);
  }
  const photo = await getPhoto(); assert.equal(photo.status, 200); assert.match(photo.headers['content-type'], /^image\/jpeg/);
  assert.equal(photo.headers['cache-control'], 'no-store'); assert.ok(Buffer.isBuffer(photo.body));
  const metadata = await sharp(photo.body).metadata(); assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined);
});
test('JPEG, PNG and WebP are decoded, resized and converted to JPEG', async () => {
  const webp = await sharp(png).webp().toBuffer();
  for (const [bytes, type] of [[image, 'image/jpeg'], [png, 'image/png'], [webp, 'image/webp']]) {
    const r = await upload({ bytes, type }); assert.equal(r.status, 200, JSON.stringify(r.body));
    const output = await getPhoto(); assert.equal((await sharp(output.body).metadata()).format, 'jpeg');
  }
});
test('replay uses the same operation and never uploads or replaces twice', async () => {
  const key = randomUUID(); const first = await upload({ key }); const second = await upload({ key });
  assert.equal(first.status, 200); assert.deepEqual(second.body.data, first.body.data); assert.equal(storage.uploads.length, 1);
  assertError(await upload({ key, bytes: png, type: 'image/png' }), 409, 'PHOTO_OPERATION_CONFLICT');
  assert.equal(storage.uploads.length, 1);
});
test('replacement preserves the old asset until database commit, then cleans it safely', async () => {
  await upload(); const old = await models.MemberProfile.findById(member._id).lean();
  const second = await upload({ bytes: png, type: 'image/png' }); assert.equal(second.status, 200);
  assert.equal(storage.assets.has(old.photoPublicId), true); assert.equal(storage.deleted.length, 0);
  assert.equal(await models.MemberPhotoCleanup.countDocuments(), 1);
  await app.locals.memberPhotoService.cleanup();
  assert.equal(storage.assets.has(old.photoPublicId), false); assert.equal(storage.assets.size, 1);
  assert.equal(await models.MemberPhotoCleanup.countDocuments(), 0);
});
test('removal is idempotent and a later image is not removed by replay of an old request', async () => {
  await upload(); const key = randomUUID(); const removed = await remove(key); assert.equal(removed.status, 200);
  assert.equal(removed.body.data.photoUrl, undefined); assertError(await getPhoto(), 404, 'PHOTO_NOT_FOUND');
  await upload(); const newest = await models.MemberProfile.findById(member._id).lean();
  assert.equal((await remove(key)).status, 200);
  assert.equal((await models.MemberProfile.findById(member._id).lean()).photoPublicId, newest.photoPublicId);
  await app.locals.memberPhotoService.cleanup(); assert.equal(storage.assets.size, 1);
});
test('provider upload failures leave the old photo working and return sanitized errors', async () => {
  await upload(); const old = await models.MemberProfile.findById(member._id).lean(); storage.failUpload = true;
  assertError(await upload({ bytes: png, type: 'image/png' }), 503, 'PHOTO_STORAGE_UNAVAILABLE');
  const saved = await models.MemberProfile.findById(member._id).lean(); assert.equal(saved.photoPublicId, old.photoPublicId);
  assert.equal(storage.deleted.length, 0); assert.equal((await getPhoto()).status, 200);
});
test('database failure after upload never deletes the previous working asset and can safely retry', async (t) => {
  await upload(); const old = await models.MemberProfile.findById(member._id).lean(); const key = randomUUID();
  const mock = t.mock.method(models.MemberProfile, 'findOneAndUpdate', () => { throw new Error('private database failure'); });
  const failed = await upload({ key, bytes: png, type: 'image/png' }); assertError(failed, 503, 'PHOTO_DATABASE_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.body).includes('private database'), false);
  assert.equal((await models.MemberProfile.findById(member._id).lean()).photoPublicId, old.photoPublicId);
  assert.equal(storage.deleted.length, 0); mock.mock.restore();
  assert.equal((await upload({ key, bytes: png, type: 'image/png' })).status, 200);
  await app.locals.memberPhotoService.cleanup(); assert.equal(storage.assets.size, 1);
});
test('cleanup failure retains a durable retry without reverting a successful replacement', async () => {
  await upload(); await upload({ bytes: png, type: 'image/png' }); storage.failDelete = true;
  await app.locals.memberPhotoService.cleanup();
  const task = await models.MemberPhotoCleanup.findOne().lean(); assert.equal(task.attempts, 1);
  assert.equal((await getPhoto()).status, 200); storage.failDelete = false;
  await models.MemberPhotoCleanup.updateOne({ _id: task._id }, { $set: { after: new Date(0) } });
  await app.locals.memberPhotoService.cleanup(); assert.equal(await models.MemberPhotoCleanup.countDocuments(), 0);
});
test('cleanup refuses to delete any currently referenced asset', async () => {
  await upload(); const saved = await models.MemberProfile.findById(member._id).lean();
  await models.MemberPhotoCleanup.create({ _id: 'referenced', publicId: saved.photoPublicId, gymId: gym._id, after: new Date(0) });
  await app.locals.memberPhotoService.cleanup(); assert.equal(storage.deleted.length, 0); assert.equal((await getPhoto()).status, 200);
});
test('missing configuration fails safely without changing member records', async () => {
  storage.configured = false; assertError(await upload(), 503, 'PHOTO_STORAGE_UNAVAILABLE');
  assert.equal(await models.MemberPhotoOperation.countDocuments(), 0);
  assert.equal((await models.MemberProfile.findById(member._id).lean()).photoPublicId, undefined);
});
test('authentication, role, account and gym authorization run before parsing/uploading', async () => {
  assertError(await upload({ auth: null }), 401, 'INVALID_AUTHENTICATION');
  for (const user of [trainer, memberUser]) {
    const denied = await login(user); assertError(await upload({ auth: denied }), 403, 'FORBIDDEN');
    const r = await request(app).delete(path()).set('Authorization', `Bearer ${denied}`).set('Idempotency-Key', randomUUID());
    assertError(r, 403, 'FORBIDDEN');
  }
  await models.GymAccess.updateOne({ userId: admin._id, gymId: gym._id }, { $set: { status: 'suspended' } });
  assertError(await upload(), 403, 'FORBIDDEN'); assert.equal(storage.uploads.length, 0);
  assert.equal(await models.MemberPhotoOperation.countDocuments(), 0);
});

test('photo reads require authorization, while authorized trainers can read existing member images', async () => {
  await upload(); assertError(await getPhoto(null), 401, 'INVALID_AUTHENTICATION');
  assertError(await getPhoto(await login(memberUser)), 403, 'FORBIDDEN');
  assert.equal((await getPhoto(await login(trainer))).status, 200);
  await models.UserAccount.updateOne({ _id: trainer._id }, { $set: { status: 'suspended' } });
  assert.equal((await getPhoto(await login())).status, 200);
});
test('cross-gym members cannot be read or modified even with access to both gyms', async () => {
  await models.GymAccess.create({ userId: admin._id, gymId: otherGym._id, role: 'admin', status: 'active' });
  const cross = path().replace(String(gym._id), String(otherGym._id));
  assertError(await upload({ url: cross }), 404, 'MEMBER_NOT_FOUND');
  assertError(await getPhoto(token, cross), 404, 'MEMBER_NOT_FOUND'); assert.equal(storage.uploads.length, 0);
});
test('spoofed MIME, truncated image, SVG, executable bytes and empty files are rejected', async () => {
  for (const [bytes, type] of [[png, 'image/jpeg'], [image.subarray(0, 60), 'image/jpeg'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'image/svg+xml'],
    [Buffer.from('MZ-not-an-image'), 'image/jpeg'], [Buffer.alloc(0), 'image/jpeg']]) {
    const r = await upload({ bytes, type }); assert.ok([400, 415].includes(r.status), JSON.stringify(r.body));
    assert.equal(storage.uploads.length, 0);
  }
});
test('server rejects oversized byte payloads and decompression bombs', async () => {
  assertError(await upload({ bytes: Buffer.alloc(MAX_PHOTO_BYTES + 1) }), 413, 'PHOTO_TOO_LARGE');
  const bomb = await sharp({ create: { width: 4500, height: 4500, channels: 3, background: 'white' } }).png().toBuffer();
  assertError(await upload({ bytes: bomb, type: 'image/png' }), 400, 'PHOTO_INVALID_IMAGE');
  assert.equal(storage.uploads.length, 0);
});
test('multiple files, unexpected form fields, JSON and invalid operation keys are rejected', async () => {
  const auth = `Bearer ${token}`;
  const multiple = await request(app).put(path()).set('Authorization', auth).set('Idempotency-Key', randomUUID())
    .attach('photo', image, 'one.jpg').attach('photo', image, 'two.jpg'); assert.equal(multiple.status, 400);
  const field = await request(app).put(path()).set('Authorization', auth).set('Idempotency-Key', randomUUID())
    .field('gymId', String(otherGym._id)).attach('photo', image, 'x.jpg'); assert.equal(field.status, 400);
  assertError(await request(app).put(path()).set('Authorization', auth).send({ photo: 'base64' }), 400, 'PHOTO_INVALID_IMAGE');
  assertError(await upload({ key: 'invalid' }), 400, 'VALIDATION_ERROR'); assert.equal(storage.uploads.length, 0);
});
test('two concurrent changes cannot overwrite a later revision silently', async () => {
  let resolve; let started;
  const ready = new Promise((r) => { started = r; }); const gate = new Promise((r) => { resolve = r; });
  const original = storage.upload.bind(storage); let calls = 0;
  storage.upload = async (...args) => { calls += 1; if (calls === 2) started(); await gate; return original(...args); };
  const first = upload().then((r) => r); const second = upload({ bytes: png, type: 'image/png' }).then((r) => r);
  await ready; resolve(); const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assertError(results.find((r) => r.status === 409), 409, 'PHOTO_CHANGED');
  assert.equal((await models.MemberProfile.findById(member._id).lean()).photoRevision, 1);
});
test('abandoned uploads are reconciled from durable records after process failure', async () => {
  storage.failUpload = true; const r = await upload(); assert.equal(r.status, 503); storage.failUpload = false;
  const operation = await models.MemberPhotoOperation.findOne().lean();
  storage.assets.set(operation.publicId, image);
  await models.MemberPhotoOperation.collection.updateOne({ _id: operation._id }, { $set: { updatedAt: new Date(0) } });
  await app.locals.memberPhotoService.cleanup();
  assert.equal(storage.assets.size, 0); assert.equal((await models.MemberPhotoOperation.findById(operation._id).lean()).state, 'abandoned');
});

test('saved-operation status resolves a committed upload without re-uploading image bytes', async () => {
  const key = randomUUID(); await upload({ key });
  const status = await request(app).get(`${path()}/operations/${key}`).set('Authorization', `Bearer ${token}`);
  assert.equal(status.status, 200); assert.equal(status.body.data.state, 'committed');
  assert.equal(storage.uploads.length, 1); assert.equal(status.body.data.photoRevision, 1);
});
