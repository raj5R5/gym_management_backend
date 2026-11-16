const { Schema } = require('mongoose');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');

const categories = ['rent', 'salaries', 'electricity', 'equipment', 'maintenance', 'marketing', 'supplies', 'other'];
const methods = ['cash', 'upi', 'bank_transfer', 'card', 'other'];

const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  category: { type: String, enum: categories, required: true, immutable: true },
  amountPaise: { type: Number, required: true, immutable: true, min: 1, max: MAX_PRICE_PAISE, validate: Number.isSafeInteger },
  // Gym-local calendar day the money was spent, as a UTC-midnight label.
  spentOn: { type: Date, required: true, immutable: true,
    validate: (value) => value.toISOString().endsWith('T00:00:00.000Z') },
  paymentMethod: { type: String, enum: methods, required: true, immutable: true },
  note: { type: String, trim: true, immutable: true, minlength: 1, maxlength: 500 },
  recordedByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  // Removal keeps the record for history; only `status`/`removedAt`/`removedByUserId` change.
  status: { type: String, enum: ['active', 'removed'], required: true, default: 'active' },
  removedAt: Date,
  removedByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, status: 1, spentOn: -1, _id: -1 }, { name: 'expense_gym_period_list' });

function getExpenseModel(connection) {
  return connection.models.Expense || connection.model('Expense', schema);
}
module.exports = { getExpenseModel, categories, methods };
