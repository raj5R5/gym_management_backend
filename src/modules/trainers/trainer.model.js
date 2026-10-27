const { Schema } = require('mongoose');
const { statuses, genders } = require('./trainer.validation');
const text = (max) => ({ type: String, trim: true, minlength: 1, maxlength: max });
const phone = { ...text(25), required: true, validate: (value) => /^\+?[0-9 ()-]+$/.test(value)
  && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15 };
const address = new Schema({ line1: { ...text(200), required: true }, line2: text(200),
  city: { ...text(100), required: true }, state: text(100), postalCode: text(20),
  countryCode: { type: String, required: true, match: /^[A-Z]{2}$/ } }, { _id: false, strict: 'throw' });
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', immutable: true },
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  // Historical storage only; no active branch relationship or assignment API.
  branchId: { type: Schema.Types.ObjectId },
  trainerCode: { type: String, required: true, trim: true, uppercase: true,
    match: /^[A-Z0-9][A-Z0-9_-]{1,31}$/, immutable: true },
  firstName: { ...text(80), required: true }, lastName: { ...text(80), required: true }, phone,
  dateOfBirth: { type: Date, validate: (value) => value <= new Date()
    && value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0 },
  gender: { type: String, enum: genders }, address,
  specializations: { type: [text(80)], default: undefined, validate: (values) => values.length <= 10
    && new Set(values.map((value) => value.toLowerCase())).size === values.length },
  status: { type: String, enum: statuses, required: true, default: 'active' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, trainerCode: 1 }, { unique: true, name: 'trainer_gym_code_unique' });
schema.index({ gymId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'trainer_gym_status_list' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'trainer_gym_list' });
function getTrainerProfileModel(connection) {
  return connection.models.TrainerProfile || connection.model('TrainerProfile', schema);
}
module.exports = { getTrainerProfileModel };
