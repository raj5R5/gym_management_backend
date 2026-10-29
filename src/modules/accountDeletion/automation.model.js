const { Schema } = require('mongoose');
const action = new Schema({ gymId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['leave', 'transfer', 'close'], required: true },
  successorId: Schema.Types.ObjectId, acceptedVersion: Number,
}, { _id: false, strict: 'throw' });
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  state: { type: String, enum: ['preview', 'queued', 'purge', 'cleanup', 'notifying', 'completed', 'needs_action'], required: true },
  scopeDigest: { type: String, required: true }, policyVersion: { type: String, required: true },
  credentialVersion: { type: Number, required: true },
  actions: { type: [action], required: true },
  confirmationDigest: { type: String, required: true, select: false },
  confirmationExpiresAt: { type: Date, required: true }, confirmedAt: Date,
  statusDigest: { type: String, required: true, select: false },
  notificationCiphertext: { type: String, select: false },
  memberCleanupKeys: { type: [String], default: [] }, ownerCleanupKeys: { type: [String], default: [] },
  closedGymIds: { type: [Schema.Types.ObjectId], default: [] },
  leaseId: String, leaseUntil: Date, nextAttemptAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 }, lastReason: String, alertPending: { type: Boolean, default: false },
  externalEvidenceRef: String, notificationRef: String, erasedAt: Date, completedAt: Date,
  events: { type: [{ _id: false, state: String, at: Date }], default: [] },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ userId: 1 }, { unique: true, name: 'deletion_job_account_unique' });
schema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 }, { name: 'deletion_job_due' });
// No TTL. A completed job keeps only ids, timestamps and evidence references: it lets the
// requester verify completion and lets a database restore re-apply the deletion.
function getDeletionJobModel(connection) {
  return connection.models.DeletionJob || connection.model('DeletionJob', schema);
}
module.exports = { getDeletionJobModel };
