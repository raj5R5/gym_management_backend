const { Schema } = require('mongoose');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { methods } = require('../payments/payment.validation');
const options = { _id: false, strict: 'throw' };
const id = { type: String, required: true, match: /^[a-f0-9]{24}$/ };
const money = { type: Number, required: true, min: 0, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger };
const member = new Schema({ id, gymId: id, branchId: String, memberCode: { type: String, required: true },
  firstName: { type: String, required: true }, lastName: { type: String, required: true },
  status: { type: String, required: true, enum: ['active'] } }, options);
const subscription = new Schema({ id, membershipPlanId: id, planNameSnapshot: { type: String, required: true },
  durationDaysSnapshot: { type: Number, required: true }, pricePaiseSnapshot: money,
  startDate: { type: String, required: true }, endDate: { type: String, required: true },
  status: { type: String, required: true, enum: ['active', 'expired'] },
  isCurrentlyActive: { type: Boolean, required: true } }, options);
const payment = new Schema({ id, subscriptionId: id, amountPaise: money,
  paymentMethod: { type: String, required: true, enum: methods }, paidAt: { type: String, required: true },
  transactionReference: String }, options);
const billing = new Schema({ planPricePaise: money, discountPaise: { ...money, max: 0 },
  amountReceivedPaise: money, outstandingBalancePaise: money }, options);
const result = new Schema({ operationId: id, member: { type: member, required: true },
  subscription: { type: subscription, default: null }, payment: { type: payment, default: null },
  billing: { type: billing, required: true } }, options);
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  keyDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  requestDigest: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  result: { type: result, required: true, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, userId: 1, keyDigest: 1 }, { unique: true, name: 'onboarding_actor_gym_key_unique' });
function getMemberOnboardingOperationModel(connection) {
  return connection.models.MemberOnboardingOperation || connection.model('MemberOnboardingOperation', schema);
}
module.exports = { getMemberOnboardingOperationModel };
