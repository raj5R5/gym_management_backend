const { Schema } = require('mongoose');
const { statuses, MAX_DURATION_DAYS, MAX_PRICE_PAISE, normalizePlanName } = require('./plan.validation');
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  name: { type: String, required: true, set: normalizePlanName, minlength: 1, maxlength: 120 },
  normalizedName: { type: String, required: true, select: false },
  durationDays: { type: Number, required: true, min: 1, max: MAX_DURATION_DAYS, validate: Number.isSafeInteger },
  // Exact integer minor units (INR paise); no rupee conversion or floating-point arithmetic.
  price: { type: Number, required: true, min: 0, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  status: { type: String, required: true, enum: statuses, default: 'active' },
  description: { type: String, trim: true, minlength: 1, maxlength: 2000 },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.pre('validate', function () {
  if (this.name) this.normalizedName = this.name.toLowerCase();
});
schema.index({ gymId: 1, normalizedName: 1 }, { unique: true, name: 'plan_gym_name_unique' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'plan_gym_list' });
schema.index({ gymId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'plan_gym_status_list' });
function getMembershipPlanModel(connection) {
  return connection.models.MembershipPlan || connection.model('MembershipPlan', schema);
}
module.exports = { getMembershipPlanModel };
