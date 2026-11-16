const { Schema } = require('mongoose');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

const reference = (ref) => ({ type: Schema.Types.ObjectId, ref, required: true, immutable: true });
const day = { type: Date, required: true, validate: (value) => value.toISOString().endsWith('T00:00:00.000Z') };

// A pause in a membership. [startDate, endDate) are gym-local days; the
// subscription's endDate moved by `days`. Ending early returns unused days.
const freezeSchema = new Schema({
  gymId: reference('Gym'), memberId: reference('MemberProfile'), subscriptionId: reference('MemberSubscription'),
  recordedByUserId: reference('UserAccount'),
  startDate: { ...day, immutable: true }, endDate: day,
  days: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  status: { type: String, enum: ['scheduled', 'ended'], required: true, default: 'scheduled' },
  reason: { type: String, trim: true, minlength: 1, maxlength: 300, immutable: true },
  endedEarlyAt: Date, endedEarlyByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
freezeSchema.index({ gymId: 1, subscriptionId: 1, startDate: 1 }, { name: 'freeze_subscription_list' });
freezeSchema.index({ gymId: 1, status: 1, startDate: 1, endDate: 1 }, { name: 'freeze_gym_active' });

// A reduction of what is owed on one membership. Immutable once recorded.
const discountSchema = new Schema({
  gymId: reference('Gym'), memberId: reference('MemberProfile'), subscriptionId: reference('MemberSubscription'),
  recordedByUserId: reference('UserAccount'),
  amountPaise: { type: Number, required: true, immutable: true, min: 1, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  // Percent as entered, for display only; the amount is authoritative.
  percent: { type: Number, immutable: true, min: 0.01, max: 100 },
  reason: { type: String, trim: true, minlength: 1, maxlength: 300, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
discountSchema.index({ gymId: 1, subscriptionId: 1, createdAt: 1 }, { name: 'discount_subscription_list' });
discountSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], function () {
  throw new Error('Discounts are immutable');
});

function getMembershipFreezeModel(connection) {
  return connection.models.MembershipFreeze || connection.model('MembershipFreeze', freezeSchema);
}
function getMembershipDiscountModel(connection) {
  return connection.models.MembershipDiscount || connection.model('MembershipDiscount', discountSchema);
}
module.exports = { getMembershipFreezeModel, getMembershipDiscountModel };
