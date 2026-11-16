const { Schema } = require('mongoose');

const methods = ['manual', 'qr'];
const membershipStates = ['active', 'frozen', 'upcoming', 'expired', 'none'];
const reference = (ref) => ({ type: Schema.Types.ObjectId, ref, required: true, immutable: true });

// One gym visit (entry). Check-in only: there is no check-out lifecycle.
// Separate from the retired Attendance collection, whose records stay untouched.
const schema = new Schema({
  gymId: reference('Gym'), memberId: reference('MemberProfile'), recordedByUserId: reference('UserAccount'),
  // Gym-local calendar day as a UTC-midnight label, like membership dates.
  visitDate: { type: Date, required: true, immutable: true,
    validate: (value) => value.toISOString().endsWith('T00:00:00.000Z') },
  checkedInAt: { type: Date, required: true, immutable: true },
  method: { type: String, enum: methods, required: true, immutable: true },
  // Membership state when the member entered; non-active entries needed an explicit override.
  membershipState: { type: String, enum: membershipStates, required: true, immutable: true },
  override: { type: Boolean, required: true, immutable: true, default: false },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.pre('save', function () { if (!this.isNew) throw new Error('Visits cannot be rewritten'); });
schema.pre(['replaceOne', 'findOneAndReplace', 'findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  throw new Error('Visits are append-only');
});
// At most one recorded entry per member per gym-local day.
schema.index({ gymId: 1, memberId: 1, visitDate: 1 }, { unique: true, name: 'visit_member_day_unique' });
schema.index({ gymId: 1, visitDate: -1, checkedInAt: -1, _id: -1 }, { name: 'visit_gym_day_list' });
schema.index({ gymId: 1, memberId: 1, checkedInAt: -1, _id: -1 }, { name: 'visit_member_history' });

function getMemberVisitModel(connection) {
  return connection.models.MemberVisit || connection.model('MemberVisit', schema);
}
module.exports = { getMemberVisitModel, methods, membershipStates };
