const { Schema } = require('mongoose');
const schema = new Schema({
  _id: { type: String, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true },
  emailDigest: { type: String, required: true },
  credentialVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true }, usedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', autoCreate: false, autoIndex: false, bufferCommands: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'password_recovery_expiry' });
function getPasswordRecoveryModel(connection) {
  return connection.models.PasswordRecovery || connection.model('PasswordRecovery', schema);
}
module.exports = { getPasswordRecoveryModel };
