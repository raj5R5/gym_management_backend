const { Schema } = require('mongoose');
const { statuses } = require('./attendance.validation');
const reference = (ref) => ({ type: Schema.Types.ObjectId, ref, required: true, immutable: true });
const schema = new Schema({
  gymId: reference('Gym'), memberId: reference('MemberProfile'), branchId: reference('Branch'),
  subscriptionId: reference('MemberSubscription'), recordedByUserId: reference('UserAccount'),
  checkInAt: { type: Date, required: true, immutable: true },
  checkOutAt: Date,
  status: { type: String, required: true, enum: statuses, default: 'open' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.pre('validate', function () {
  if ((this.status === 'completed' && !this.checkOutAt) || (this.status === 'open' && this.checkOutAt)
    || (this.checkOutAt && this.checkOutAt < this.checkInAt)) this.invalidate('checkOutAt', 'Invalid attendance lifecycle');
});
schema.pre('save', function () {
  if (!this.isNew) throw new Error('Attendance documents cannot be rewritten');
});
schema.pre(['replaceOne', 'findOneAndReplace'], function () {
  throw new Error('Attendance documents cannot be replaced');
});
// Query updates may only perform the one-way open -> completed transition.
// This also protects checkOutAt on completed records from model query updates.
schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  const update = this.getUpdate();
  const fields = Object.keys(update.$set || {}).filter((field) => field !== 'updatedAt');
  if (this.getFilter().status !== 'open' || update.$set?.status !== 'completed'
    || !(update.$set?.checkOutAt instanceof Date) || fields.some((field) => !['status', 'checkOutAt'].includes(field))
    || Object.keys(update).some((operator) => !['$set', '$setOnInsert'].includes(operator)) || this.getOptions().upsert) {
    throw new Error('Attendance only supports closing an open visit');
  }
});
schema.index({ gymId: 1, memberId: 1 }, { unique: true, partialFilterExpression: { status: 'open' }, name: 'attendance_open_member_unique' });
schema.index({ gymId: 1, memberId: 1, checkInAt: -1, _id: -1 }, { name: 'attendance_member_list' });
schema.index({ gymId: 1, branchId: 1, checkInAt: -1, _id: -1 }, { name: 'attendance_branch_list' });
schema.index({ gymId: 1, subscriptionId: 1, checkInAt: -1, _id: -1 }, { name: 'attendance_subscription_list' });
schema.index({ gymId: 1, status: 1, checkInAt: -1, _id: -1 }, { name: 'attendance_status_list' });
schema.index({ gymId: 1, checkInAt: -1, _id: -1 }, { name: 'attendance_gym_list' });
function getAttendanceModel(connection) { return connection.models.Attendance || connection.model('Attendance', schema); }
module.exports = { getAttendanceModel };
