const { Schema } = require('mongoose');

// Per-gym sequence. One document per (gymId, key); `seq` only increases.
const counterSchema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  key: { type: String, required: true, immutable: true, enum: ['receipt'] },
  seq: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
counterSchema.index({ gymId: 1, key: 1 }, { unique: true, name: 'counter_gym_key_unique' });

// A receipt number is issued once per succeeded payment and never changes.
const receiptSchema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, immutable: true },
  sequence: { type: Number, required: true, immutable: true, min: 1, validate: Number.isSafeInteger },
  issuedAt: { type: Date, required: true, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
receiptSchema.index({ gymId: 1, paymentId: 1 }, { unique: true, name: 'receipt_gym_payment_unique' });
receiptSchema.index({ gymId: 1, sequence: 1 }, { unique: true, name: 'receipt_gym_sequence_unique' });
receiptSchema.pre(['replaceOne', 'findOneAndReplace', 'findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  throw new Error('Receipts are immutable');
});

function getGymCounterModel(connection) {
  return connection.models.GymCounter || connection.model('GymCounter', counterSchema);
}
function getPaymentReceiptModel(connection) {
  return connection.models.PaymentReceipt || connection.model('PaymentReceipt', receiptSchema);
}
module.exports = { getGymCounterModel, getPaymentReceiptModel };
