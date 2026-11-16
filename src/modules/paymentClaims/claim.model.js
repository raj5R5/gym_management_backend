const { Schema } = require('mongoose');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true, immutable: true });
const statuses = ['pending', 'confirmed', 'rejected'];

// A member's "I paid by UPI" note. It becomes a real Payment only when the owner confirms it.
const schema = new Schema({
  gymId: ref('Gym'), memberId: ref('MemberProfile'), subscriptionId: ref('MemberSubscription'),
  amountPaise: { type: Number, required: true, immutable: true, min: 1, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  // The 12-digit UPI transaction ID (UTR) from the member's UPI app.
  reference: { type: String, required: true, immutable: true, match: /^\d{12}$/ },
  status: { type: String, enum: statuses, required: true, default: 'pending' },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
  decidedByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount' },
  decidedAt: Date,
  rejectReason: { type: String, trim: true, minlength: 1, maxlength: 200 },
  createdByUserId: ref('UserAccount'),
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
// One live claim per UPI transaction in a gym: the same UTR cannot be claimed twice.
schema.index({ gymId: 1, reference: 1 }, { unique: true, name: 'claim_reference_unique',
  partialFilterExpression: { status: { $in: ['pending', 'confirmed'] } } });
schema.index({ gymId: 1, status: 1, createdAt: -1 }, { name: 'claim_gym_status' });
schema.index({ gymId: 1, memberId: 1, createdAt: -1 }, { name: 'claim_member' });

const getPaymentClaimModel = (connection) => connection.models.PaymentClaim || connection.model('PaymentClaim', schema);
module.exports = { getPaymentClaimModel, statuses };
