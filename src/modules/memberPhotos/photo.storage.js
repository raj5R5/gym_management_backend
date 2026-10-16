const cloudinary = require('cloudinary').v2;
const { MAX_PHOTO_BYTES, fail } = require('./photo.image');
function createPhotoStorage(config) {
  const credentials = config.cloudinary;
  const configured = Boolean(credentials?.cloudName && credentials?.apiKey && credentials?.apiSecret);
  const options = { cloud_name: credentials?.cloudName, api_key: credentials?.apiKey,
    api_secret: credentials?.apiSecret, secure: true, timeout: 60_000 };
  const guard = () => { if (!configured) fail('PHOTO_STORAGE_UNAVAILABLE'); };
  const validId = (id) => /^gym_members\/[a-f0-9]{24}\/[a-f0-9]{24}\/[a-f0-9-]{36}$/.test(id);
  return {
    configured,
    async upload(bytes, publicId) {
      guard(); if (!validId(publicId)) fail('PHOTO_INVALID_IMAGE');
      try {
        let result = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream({ ...options, public_id: publicId, resource_type: 'image',
            type: 'authenticated', overwrite: false, format: 'jpg' },
          (error, value) => error ? reject(error) : resolve(value)).end(bytes);
        });
        // An immutable asset may already exist after a lost upload response or
        // a database rollback. Cloudinary returns only { existing: true } in
        // that case; resolve its authenticated metadata before committing.
        if (result.existing === true) result = await cloudinary.uploader.explicit(publicId, {
          ...options, type: 'authenticated', resource_type: 'image' });
        if (result.public_id !== publicId || result.type !== 'authenticated'
          || !result.secure_url?.startsWith('https://res.cloudinary.com/')) fail('PHOTO_STORAGE_UNAVAILABLE');
        return { url: result.secure_url, publicId };
      } catch { fail('PHOTO_STORAGE_UNAVAILABLE'); }
    },
    async read(publicId) {
      guard(); if (!validId(publicId)) fail('PHOTO_STORAGE_UNAVAILABLE');
      try {
        const url = cloudinary.utils.private_download_url(publicId, 'jpg', { ...options,
          type: 'authenticated', resource_type: 'image', expires_at: Math.floor(Date.now() / 1000) + 60 });
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) fail('PHOTO_STORAGE_UNAVAILABLE');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > MAX_PHOTO_BYTES) { await reader.cancel(); fail('PHOTO_STORAGE_UNAVAILABLE'); }
          chunks.push(Buffer.from(value));
        }
        if (!size) fail('PHOTO_STORAGE_UNAVAILABLE');
        return Buffer.concat(chunks);
      } catch { fail('PHOTO_STORAGE_UNAVAILABLE'); }
    },
    async destroy(publicId) {
      guard(); if (!validId(publicId)) fail('PHOTO_STORAGE_UNAVAILABLE');
      try {
        const result = await cloudinary.uploader.destroy(publicId, { ...options,
          type: 'authenticated', resource_type: 'image', invalidate: true });
        if (!['ok', 'not found'].includes(result.result)) fail('PHOTO_STORAGE_UNAVAILABLE');
      } catch { fail('PHOTO_STORAGE_UNAVAILABLE'); }
    },
  };
}
module.exports = { createPhotoStorage };
