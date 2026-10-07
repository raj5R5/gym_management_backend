const { Schema } = require('mongoose');
const { statuses, genders } = require('./member.validation');
const text = (max) => ({ type: String, trim: true, minlength: 1, maxlength: max });
const phone = { ...text(25), required: true, validate: (value) => /^\+?[0-9 ()-]+$/.test(value)
  && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15 };
const address = new Schema({ line1: { ...text(200), required: true }, line2: text(200),
  city: { ...text(100), required: true }, state: text(100), postalCode: text(20),
  countryCode: { type: String, required: true, match: /^[A-Z]{2}$/ } }, { _id: false, strict: 'throw' });
const emergencyContact = new Schema({ name: { ...text(120), required: true }, phone,
  relationship: text(80) }, { _id: false, strict: 'throw' });
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', immutable: true },
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
  memberCode: { type: String, required: true, trim: true, uppercase: true,
    match: /^[A-Z0-9][A-Z0-9_-]{1,31}$/, immutable: true },
  firstName: { ...text(80), required: true }, lastName: { ...text(80), required: true }, phone,
  dateOfBirth: { type: Date, validate: (value) => value <= new Date()
    && value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0 },
  gender: { type: String, enum: genders }, address, emergencyContact,
  status: { type: String, enum: statuses, required: true, default: 'active' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, memberCode: 1 }, { unique: true, name: 'member_gym_code_unique' });
schema.index({ gymId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'member_gym_status_list' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'member_gym_list' });
function getMemberProfileModel(connection) {
  return connection.models.MemberProfile || connection.model('MemberProfile', schema);
}
module.exports = { getMemberProfileModel };
