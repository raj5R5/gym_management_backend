const { Schema } = require('mongoose');
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  status: { type: String, enum: ['requested', 'in_review', 'completed'], required: true, default: 'requested' },
  requestedAt: { type: Date, required: true, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
// One durable request per account: concurrent submissions/retries return it.
schema.index({ userId: 1 }, { unique: true, name: 'account_deletion_user_unique' });
schema.index({ status: 1, requestedAt: 1 }, { name: 'account_deletion_review_queue' });
function getAccountDeletionRequestModel(connection) {
  return connection.models.AccountDeletionRequest || connection.model('AccountDeletionRequest', schema);
}
module.exports = { getAccountDeletionRequestModel };
