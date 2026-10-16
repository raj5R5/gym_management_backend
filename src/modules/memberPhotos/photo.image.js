const sharp = require('sharp');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
function fail(code) { const error = new Error('Photo could not be processed.'); error.code = code; throw error; }
async function preparePhoto(file) {
  if (!file?.buffer?.length) fail('PHOTO_INVALID_IMAGE');
  if (file.buffer.length > MAX_PHOTO_BYTES) fail('PHOTO_TOO_LARGE');
  const types = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
  if (!types[file.mimetype]) fail('PHOTO_UNSUPPORTED_TYPE');
  try {
    const image = sharp(file.buffer, { limitInputPixels: 20_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== types[file.mimetype] || (metadata.pages ?? 1) !== 1) fail('PHOTO_UNSUPPORTED_TYPE');
    // Decode and re-encode; a matching header/extension is not enough. Metadata,
    // embedded profiles, and location EXIF are not retained in the stored JPEG.
    const bytes = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    if (bytes.length > MAX_PHOTO_BYTES) fail('PHOTO_TOO_LARGE');
    return bytes;
  } catch (error) {
    if (error.code?.startsWith('PHOTO_')) throw error;
    fail('PHOTO_INVALID_IMAGE');
  }
}
module.exports = { MAX_PHOTO_BYTES, preparePhoto, fail };
