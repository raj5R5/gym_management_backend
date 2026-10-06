const { Schema } = require('mongoose');
const { contactSchema } = require('../gyms/gym.model');

const addressSchema = new Schema({
  line1: { type: String, required: true, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  state: { type: String, trim: true, maxlength: 100 },
  postalCode: { type: String, trim: true, maxlength: 20 },
  countryCode: { type: String, required: true, match: /^[A-Z]{2}$/ },
}, { _id: false, strict: 'throw' });
const branchSchema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  nameKey: { type: String, required: true, select: false },
  address: { type: addressSchema, required: true },
  contact: contactSchema,
  status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
branchSchema.index({ gymId: 1, nameKey: 1 }, { unique: true, name: 'branch_gym_name_unique' });
branchSchema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'branch_gym_list' });

function getBranchModel(connection) {
  return connection.models.Branch || connection.model('Branch', branchSchema);
}

module.exports = { getBranchModel };
