const { Schema } = require('mongoose');
const { statuses } = require('./subscription.validation');
const { MAX_DURATION_DAYS, MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const date = { type: Date, required: true, immutable: true, validate: (value) =>
  value.getUTCFullYear() >= 1 && value.getUTCFullYear() <= 9999 && value.toISOString().endsWith('T00:00:00.000Z') };
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile', required: true, immutable: true },
  membershipPlanId: { type: Schema.Types.ObjectId, ref: 'MembershipPlan', required: true, immutable: true },
  startDate: date, endDate: date,
  status: { type: String, enum: statuses, required: true, default: 'active' },
  planNameSnapshot: { type: String, required: true, immutable: true, minlength: 1, maxlength: 120 },
  durationDaysSnapshot: { type: Number, required: true, immutable: true, min: 1, max: MAX_DURATION_DAYS, validate: Number.isSafeInteger },
  pricePaiseSnapshot: { type: Number, required: true, immutable: true, min: 0, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  notes: { type: String, trim: true, minlength: 1, maxlength: 2000 },
  cancelledAt: Date, cancellationReason: { type: String, trim: true, minlength: 1, maxlength: 500 },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.pre('validate', function () {
  if (this.startDate && this.endDate && Number.isSafeInteger(this.durationDaysSnapshot)) {
    const expected = new Date(this.startDate); expected.setUTCDate(expected.getUTCDate() + this.durationDaysSnapshot);
    if (expected.getTime() !== this.endDate.getTime()) this.invalidate('endDate', 'Invalid subscription period');
  }
});
schema.index({ gymId: 1, memberId: 1, startDate: 1, endDate: 1 }, { name: 'subscription_member_period' });
schema.index({ gymId: 1, membershipPlanId: 1, createdAt: -1, _id: -1 }, { name: 'subscription_plan_list' });
schema.index({ gymId: 1, status: 1, endDate: 1 }, { name: 'subscription_gym_status_end' });
schema.index({ gymId: 1, startDate: 1 }, { name: 'subscription_gym_start' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'subscription_gym_list' });
function getMemberSubscriptionModel(connection) {
  return connection.models.MemberSubscription || connection.model('MemberSubscription', schema);
}
module.exports = { getMemberSubscriptionModel };
