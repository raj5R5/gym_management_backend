const { Schema } = require('mongoose');
const schema = new Schema({
  tokenDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/, select: false, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile', required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ tokenDigest: 1 }, { unique: true, name: 'member_activation_digest_unique' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'member_activation_expiry' });
function getMemberActivationModel(connection) {
  return connection.models.MemberActivation || connection.model('MemberActivation', schema);
}
module.exports = { getMemberActivationModel };
