const { Schema } = require('mongoose');

const contactSchema = new Schema({
  email: { type: String, trim: true, lowercase: true, maxlength: 254 },
  phone: { type: String, trim: true, maxlength: 25 },
}, { _id: false, strict: 'throw' });
const text = (max) => ({ type: String, trim: true, minlength: 1, maxlength: max });
const addressSchema = new Schema({
  line1: { ...text(200), required: true }, line2: text(200),
  city: { ...text(100), required: true }, state: text(100), postalCode: text(12),
}, { _id: false, strict: 'throw' });
// Owner-editable business settings. The timezone drives every gym-local calendar rule.
const settingsSchema = new Schema({
  timezone: { type: String, maxlength: 100 },
  gstin: { type: String, trim: true, uppercase: true, match: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/ },
  address: addressSchema,
  // UPI VPA for "pay by UPI" QR codes, and the payee name shown in UPI apps.
  upiId: { type: String, trim: true, lowercase: true, match: /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/ },
  upiPayeeName: { type: String, trim: true, minlength: 1, maxlength: 50 },
}, { _id: false, strict: 'throw' });

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
