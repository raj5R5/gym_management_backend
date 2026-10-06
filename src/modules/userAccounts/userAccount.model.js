const { Schema } = require('mongoose');
const { accountStatuses, normalizeEmail } = require('./userAccount.validation');

const userAccountSchema = new Schema({
  email: { type: String, required: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, select: false },
  normalizedEmail: { type: String, required: true, select: false },
  displayName: { type: String, trim: true, minlength: 1, maxlength: 120 },
  status: { type: String, enum: accountStatuses, required: true, default: 'inactive' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
userAccountSchema.pre('validate', function () {
  if (this.email) this.normalizedEmail = normalizeEmail(this.email);
});
userAccountSchema.index({ normalizedEmail: 1 }, { unique: true, name: 'account_email_unique' });
userAccountSchema.index({ createdAt: -1, _id: -1 }, { name: 'account_list' });

function getUserAccountModel(connection) {
  return connection.models.UserAccount || connection.model('UserAccount', userAccountSchema);
}

module.exports = { getUserAccountModel };
