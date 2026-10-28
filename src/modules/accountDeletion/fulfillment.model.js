const { Schema } = require('mongoose');
const reference = { type: String, required: true, minlength: 3, maxlength: 160 };
const schema = new Schema({
  _id: { type: Schema.Types.ObjectId }, userId: { type: Schema.Types.ObjectId, required: true },
  reviewer: reference, identityRef: reference, retentionRef: reference, ownershipRef: reference,
  backupRef: reference, scopeDigest: reference,
  retainedCategories: { type: [{ category: String, purpose: String, criteria: String }], required: true },
  stage: { type: String, enum: ['reviewed', 'cleanup_pending', 'completed'], required: true },
  cleanupKeys: { type: [String], default: [] }, profileIds: { type: [Schema.Types.ObjectId], default: [] },
  notificationRef: String, offAppRef: String, fulfilledAt: Date, completedAt: Date,
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
function getDeletionFulfillmentModel(connection) {
  return connection.models.DeletionFulfillment || connection.model('DeletionFulfillment', schema);
}
module.exports = { getDeletionFulfillmentModel };
