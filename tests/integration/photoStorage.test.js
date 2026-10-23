const { test } = require('node:test');
const assert = require('node:assert/strict');
const cloudinary = require('cloudinary').v2;
const { createPhotoStorage } = require('../../src/modules/memberPhotos/photo.storage');
const publicId = `gym_members/${'a'.repeat(24)}/${'b'.repeat(24)}/12345678-1234-4123-8123-123456789012`;
const config = { cloudinary: { cloudName: 'test-only', apiKey: 'test-only', apiSecret: 'test-only' } };
const value = { public_id: publicId, type: 'authenticated', secure_url: `https://res.cloudinary.com/test-only/image/authenticated/${publicId}.jpg` };
test('storage uploads immutable authenticated images without global credentials', async (t) => {
  t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.type, 'authenticated'); assert.equal(options.overwrite, false);
    assert.equal(options.public_id, publicId); assert.equal(options.api_secret, 'test-only');
    return { end(bytes) { assert.equal(bytes.toString(), 'image'); callback(null, value); } };
  });
  const result = await createPhotoStorage(config).upload(Buffer.from('image'), publicId);
  assert.deepEqual(result, { publicId, url: value.secure_url });
});
test('existing immutable provider asset is recovered after a lost response or database rollback', async (t) => {
  t.mock.method(cloudinary.uploader, 'upload_stream', (_options, callback) => ({ end() { callback(null, { existing: true }); } }));
  const explicit = t.mock.method(cloudinary.uploader, 'explicit', async (id, options) => {
    assert.equal(id, publicId); assert.equal(options.type, 'authenticated'); return value;
  });
  assert.equal((await createPhotoStorage(config).upload(Buffer.from('image'), publicId)).url, value.secure_url);
  assert.equal(explicit.mock.callCount(), 1);
});
test('unexpected asset metadata and provider exceptions return sanitized failures', async (t) => {
  t.mock.method(cloudinary.uploader, 'upload_stream', (_options, callback) => ({ end() { callback(null, { ...value, public_id: 'foreign' }); } }));
  await assert.rejects(createPhotoStorage(config).upload(Buffer.from('image'), publicId), { code: 'PHOTO_STORAGE_UNAVAILABLE' });
});
test('missing configuration prevents any provider request', async (t) => {
  const upload = t.mock.method(cloudinary.uploader, 'upload_stream', () => { throw new Error('must not run'); });
  const store = createPhotoStorage({ cloudinary: {} }); assert.equal(store.configured, false);
  await assert.rejects(store.upload(Buffer.from('image'), publicId), { code: 'PHOTO_STORAGE_UNAVAILABLE' });
  assert.equal(upload.mock.callCount(), 0);
});
test('asset deletion uses authenticated namespace and permits already deleted assets', async (t) => {
  t.mock.method(cloudinary.uploader, 'destroy', async (id, options) => {
    assert.equal(id, publicId); assert.equal(options.type, 'authenticated'); assert.equal(options.invalidate, true);
    return { result: 'not found' };
  });
  await createPhotoStorage(config).destroy(publicId);
});
test('owner storage accepts only the owner namespace without widening member storage', async (t) => {
  const ownerId = publicId.replace('gym_members/', 'gym_owners/');
  const upload = t.mock.method(cloudinary.uploader, 'upload_stream', (options, callback) => {
    assert.equal(options.public_id, ownerId); assert.equal(options.type, 'authenticated');
    return { end() { callback(null, { ...value, public_id: ownerId }); } };
  });
  await assert.rejects(createPhotoStorage(config).upload(Buffer.from('image'), ownerId), { code: 'PHOTO_INVALID_IMAGE' });
  await assert.rejects(createPhotoStorage(config, 'owner').upload(Buffer.from('image'), publicId), { code: 'PHOTO_INVALID_IMAGE' });
  assert.equal(upload.mock.callCount(), 0);
  assert.equal((await createPhotoStorage(config, 'owner').upload(Buffer.from('image'), ownerId)).publicId, ownerId);
  assert.equal(upload.mock.callCount(), 1);
  assert.throws(() => createPhotoStorage(config, 'arbitrary'), TypeError);
});
