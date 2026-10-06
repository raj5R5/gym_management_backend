const { Schema } = require('mongoose');

const contactSchema = new Schema({
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 25 },
}, { _id: false, strict: 'throw' });
const settingsSchema = new Schema({ timezone: { type: String, maxlength: 100 } },
  { _id: false, strict: 'throw' });

const gymSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  nameKey: { type: String, required: true, select: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
  contact: contactSchema,
  settings: settingsSchema,
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
gymSchema.index({ nameKey: 1 }, { unique: true, name: 'gym_name_unique' });
gymSchema.index({ createdAt: -1, _id: -1 }, { name: 'gym_list' });

function getGymModel(connection) {
  return connection.models.Gym || connection.model('Gym', gymSchema);
}

module.exports = { getGymModel, contactSchema };
