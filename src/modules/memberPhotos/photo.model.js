const { Schema } = require('mongoose');
const options = { strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false };
const operationSchema = new Schema({
  _id: String,
  gymId: { type: Schema.Types.ObjectId, required: true },
  memberId: { type: Schema.Types.ObjectId, required: true },
  actorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['upload', 'remove'], required: true },
  digest: { type: String, required: true },
  baseRevision: { type: Number, required: true },
  publicId: String,
  state: { type: String, enum: ['prepared', 'uploading', 'committed', 'abandoned'], required: true },
  leaseId: String,
  leaseUntil: Date,
}, { ...options, timestamps: true });
const cleanupSchema = new Schema({
  _id: String,
  publicId: { type: String, required: true },
  gymId: { type: Schema.Types.ObjectId, required: true },
  after: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
}, { ...options, timestamps: true });
cleanupSchema.index({ after: 1 }, { name: 'member_photo_cleanup_due' });
operationSchema.index({ state: 1, leaseUntil: 1 }, { name: 'member_photo_operation_recovery' });
function photoModels(connection, subject = 'Member') {
  if (!['Member', 'Owner'].includes(subject)) throw new TypeError('Unsupported photo subject.');
  return {
    PhotoOperation: connection.models[`${subject}PhotoOperation`]
      || connection.model(`${subject}PhotoOperation`, operationSchema),
    PhotoCleanup: connection.models[`${subject}PhotoCleanup`]
      || connection.model(`${subject}PhotoCleanup`, cleanupSchema),
  };
}
module.exports = { photoModels };
