const { Schema } = require('mongoose');
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
  clientType: { type: String, enum: ['web', 'mobile'], required: true },
  currentTokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  idleExpiresAt: { type: Date, required: true },
  lastUsedAt: { type: Date, required: true },
  revokedAt: Date,
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ userId: 1, status: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
function getAuthSessionModel(connection) {
  return connection.models.AuthSession || connection.model('AuthSession', schema);
}
module.exports = { getAuthSessionModel };
