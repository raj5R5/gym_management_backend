const { Schema } = require('mongoose');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { methods } = require('../payments/payment.fields');

const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true, immutable: true });
const day = { type: Date, validate: (value) => value.toISOString().endsWith('T00:00:00.000Z') };
const paise = { type: Number, min: 0, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger };
const percent = { type: Number, min: 0, max: 100 };

// A PT package: N sessions with one trainer for one member, at a price.
const packageSchema = new Schema({
  gymId: ref('Gym'), memberId: ref('MemberProfile'), trainerId: ref('TrainerProfile'),
  name: { type: String, trim: true, required: true, minlength: 1, maxlength: 120, immutable: true },
  sessionsTotal: { type: Number, required: true, min: 1, max: 200, immutable: true, validate: Number.isSafeInteger },
  sessionsUsed: { type: Number, required: true, min: 0, default: 0, validate: Number.isSafeInteger },
  pricePaise: { ...paise, required: true, immutable: true },
  // Running total of PT payments; written only by conditional increments.
  paidPaise: { ...paise, required: true, default: 0 },
  startDate: { ...day, required: true, immutable: true },
  // Exclusive last day; optional (no expiry).
  expiresOn: { ...day, immutable: true },
  // Trainer's commission rate when sold; later rate changes do not rewrite it.
  commissionPercent: { ...percent, required: true, immutable: true },
  status: { type: String, enum: ['active', 'completed', 'cancelled'], required: true, default: 'active' },
  cancelledAt: Date,
  createdByUserId: ref('UserAccount'),
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
packageSchema.index({ gymId: 1, memberId: 1, createdAt: -1 }, { name: 'pt_package_member' });
packageSchema.index({ gymId: 1, trainerId: 1, status: 1 }, { name: 'pt_package_trainer' });

const paymentSchema = new Schema({
  gymId: ref('Gym'), packageId: ref('PtPackage'), memberId: ref('MemberProfile'), trainerId: ref('TrainerProfile'),
  amountPaise: { ...paise, required: true, immutable: true, min: 1 },
  paymentMethod: { type: String, enum: methods, required: true, immutable: true },
  reference: { type: String, trim: true, immutable: true, minlength: 3, maxlength: 120 },
  paidAt: { type: Date, required: true, immutable: true },
  commissionPercent: { ...percent, required: true, immutable: true },
  commissionPaise: { ...paise, required: true, immutable: true },
  recordedByUserId: ref('UserAccount'),
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
paymentSchema.index({ gymId: 1, packageId: 1 }, { name: 'pt_payment_package' });
paymentSchema.index({ gymId: 1, paidAt: -1 }, { name: 'pt_payment_period' });
paymentSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne'], function () {
  throw new Error('PT payments are immutable');
});

const sessionSchema = new Schema({
  gymId: ref('Gym'), packageId: ref('PtPackage'), memberId: ref('MemberProfile'), trainerId: ref('TrainerProfile'),
  sessionDate: { ...day, required: true, immutable: true },
  note: { type: String, trim: true, immutable: true, minlength: 1, maxlength: 300 },
  loggedByUserId: ref('UserAccount'),
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
sessionSchema.index({ gymId: 1, packageId: 1, sessionDate: -1 }, { name: 'pt_session_package' });
sessionSchema.index({ gymId: 1, trainerId: 1, sessionDate: -1 }, { name: 'pt_session_trainer' });

const rateSchema = new Schema({
  gymId: ref('Gym'), trainerId: ref('TrainerProfile'),
  percent: { ...percent, required: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
rateSchema.index({ gymId: 1, trainerId: 1 }, { unique: true, name: 'pt_rate_trainer_unique' });

const get = (name, schema) => (connection) => connection.models[name] || connection.model(name, schema);
module.exports = {
  getPtPackageModel: get('PtPackage', packageSchema), getPtPaymentModel: get('PtPayment', paymentSchema),
  getPtSessionModel: get('PtSession', sessionSchema), getTrainerCommissionRateModel: get('TrainerCommissionRate', rateSchema),
};
