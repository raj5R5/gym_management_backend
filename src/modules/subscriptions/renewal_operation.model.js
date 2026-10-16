const { Schema } = require('mongoose');
// Only a confirmed, server-generated JSON receipt is stored. No raw key or request.
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  subscriptionId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  keyDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  requestDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  resultJson: { type: String, required: true, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, userId: 1, keyDigest: 1 }, { unique: true, name: 'renewal_actor_gym_key_unique' });
function getRenewalOperationModel(connection) {
  return connection.models.RenewalOperation || connection.model('RenewalOperation', schema);
}
module.exports = { getRenewalOperationModel };
