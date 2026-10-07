const { Schema } = require('mongoose');
const { statuses, methods } = require('./payment.validation');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile', required: true, immutable: true },
  subscriptionId: { type: Schema.Types.ObjectId, ref: 'MemberSubscription', required: true, immutable: true },
  amountPaise: { type: Number, required: true, immutable: true, min: 1, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  status: { type: String, enum: statuses, required: true, immutable: true, default: 'succeeded' },
  paymentMethod: { type: String, enum: methods, required: true, immutable: true },
  paidAt: { type: Date, required: true, immutable: true, min: new Date('1970-01-01T00:00:00Z'), validate: (value) => value <= new Date() },
  transactionReference: { type: String, trim: true, immutable: true, minlength: 3, maxlength: 120, match: /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/ },
  notes: { type: String, trim: true, immutable: true, minlength: 1, maxlength: 2000 },
  recordedByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount', immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, paymentMethod: 1, transactionReference: 1 }, { unique: true,
  partialFilterExpression: { status: 'succeeded', transactionReference: { $type: 'string' } }, name: 'payment_gym_method_reference_unique' });
schema.index({ gymId: 1, subscriptionId: 1, status: 1 }, { name: 'payment_subscription_total' });
schema.index({ gymId: 1, memberId: 1, paidAt: -1, _id: -1 }, { name: 'payment_member_list' });
schema.index({ gymId: 1, status: 1, paidAt: -1, _id: -1 }, { name: 'payment_gym_status_list' });
schema.index({ gymId: 1, paidAt: -1, _id: -1 }, { name: 'payment_gym_list' });
function getPaymentModel(connection) { return connection.models.Payment || connection.model('Payment', schema); }
module.exports = { getPaymentModel };
