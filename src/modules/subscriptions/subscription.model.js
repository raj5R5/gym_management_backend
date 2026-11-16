const { Schema } = require('mongoose');
const { statuses } = require('./subscription.validation');
const { MAX_DURATION_DAYS, MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const date = { type: Date, required: true, immutable: true, validate: (value) =>
  value.getUTCFullYear() >= 1 && value.getUTCFullYear() <= 9999 && value.toISOString().endsWith('T00:00:00.000Z') };
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile', required: true, immutable: true },
  membershipPlanId: { type: Schema.Types.ObjectId, ref: 'MembershipPlan', required: true, immutable: true },
  previousSubscriptionId: { type: Schema.Types.ObjectId, ref: 'MemberSubscription', immutable: true },
  // endDate moves only through a recorded freeze (see memberAdjustments):
  // endDate = startDate + durationDaysSnapshot + frozenDays.
  startDate: date, endDate: { ...date, immutable: false },
  frozenDays: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
  status: { type: String, enum: statuses, required: true, default: 'active' },
  planNameSnapshot: { type: String, required: true, immutable: true, minlength: 1, maxlength: 120 },
  durationDaysSnapshot: { type: Number, required: true, immutable: true, min: 1, max: MAX_DURATION_DAYS, validate: Number.isSafeInteger },
  // The amount owed. Lowered only by a recorded discount; list price = price + discountPaise.
  pricePaiseSnapshot: { type: Number, required: true, min: 0, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  discountPaise: { type: Number, min: 0, max: MAX_PRICE_PAISE, default: 0, validate: Number.isSafeInteger },
  notes: { type: String, trim: true, minlength: 1, maxlength: 2000 },
  cancelledAt: Date, cancellationReason: { type: String, trim: true, minlength: 1, maxlength: 500 },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.pre('validate', function () {
  if (this.previousSubscriptionId && String(this.previousSubscriptionId) === String(this._id))
    this.invalidate('previousSubscriptionId', 'A subscription cannot renew itself');
  if (this.startDate && this.endDate && Number.isSafeInteger(this.durationDaysSnapshot)) {
    const expected = new Date(this.startDate);
    expected.setUTCDate(expected.getUTCDate() + this.durationDaysSnapshot + (this.frozenDays ?? 0));
    if (expected.getTime() !== this.endDate.getTime()) this.invalidate('endDate', 'Invalid subscription period');
  }
});
// endDate, price and their adjustment counters behave as immutable for every
// query update except the freeze/discount service, which opts in explicitly.
const ADJUSTABLE = ['endDate', 'frozenDays', 'pricePaiseSnapshot', 'discountPaise'];
schema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  if (this.getOptions().membershipAdjustment === true) return;
  const update = this.getUpdate();
  if (!update) return;
  for (const target of [update, ...['$set', '$inc', '$unset', '$setOnInsert', '$min', '$max', '$mul']
    .map((operator) => update[operator]).filter(Boolean)]) {
    for (const field of ADJUSTABLE) delete target[field];
  }
});
schema.index({ gymId: 1, previousSubscriptionId: 1 }, { name: 'subscription_gym_predecessor' });
schema.index({ gymId: 1, memberId: 1, startDate: 1, endDate: 1 }, { name: 'subscription_member_period' });
schema.index({ gymId: 1, membershipPlanId: 1, createdAt: -1, _id: -1 }, { name: 'subscription_plan_list' });
schema.index({ gymId: 1, status: 1, endDate: 1 }, { name: 'subscription_gym_status_end' });
schema.index({ gymId: 1, startDate: 1 }, { name: 'subscription_gym_start' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'subscription_gym_list' });
function getMemberSubscriptionModel(connection) {
  return connection.models.MemberSubscription || connection.model('MemberSubscription', schema);
}
module.exports = { getMemberSubscriptionModel };
