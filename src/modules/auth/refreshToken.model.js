const { Schema } = require('mongoose');
const schema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'AuthSession', required: true, immutable: true },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  // Retain consumed credentials until the absolute session expiry for reuse detection.
  purgeAt: { type: Date, required: true },
  usedAt: Date,
  revokedAt: Date,
  replacedBy: { type: Schema.Types.ObjectId, ref: 'RefreshTokenRecord' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ sessionId: 1 });
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
function getRefreshTokenModel(connection) {
  return connection.models.RefreshTokenRecord || connection.model('RefreshTokenRecord', schema);
}
module.exports = { getRefreshTokenModel };
