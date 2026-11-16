const { Schema } = require('mongoose');

const statuses = ['new', 'contacted', 'trial', 'joined', 'lost'];
const sources = ['walk_in', 'phone_call', 'whatsapp', 'instagram', 'facebook', 'google', 'website', 'referral', 'other'];
const OPEN = ['new', 'contacted', 'trial'];
const text = (max) => ({ type: String, trim: true, minlength: 1, maxlength: max });
const day = { type: Date, validate: (value) => value.toISOString().endsWith('T00:00:00.000Z') };

const noteSchema = new Schema({
  text: { ...text(1000), required: true },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true },
  createdAt: { type: Date, required: true },
}, { strict: 'throw' });

// An enquiry: someone interested in joining, followed until they join or are lost.
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  firstName: { ...text(80), required: true }, lastName: text(80),
  phone: { ...text(25), required: true },
  phoneDigits: { type: String, required: true, match: /^[0-9]{7,15}$/ },
  source: { type: String, enum: sources, required: true },
  // Referral tracking only (owner choice): no automatic reward.
  referredByMemberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile' },
  interestedPlanId: { type: Schema.Types.ObjectId, ref: 'MembershipPlan' },
  status: { type: String, enum: statuses, required: true, default: 'new' },
  nextFollowUpOn: day,
  trialStartDate: day, trialEndDate: day,
  lostReason: text(300),
  convertedMemberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile' },
  convertedAt: Date,
  notes: { type: [noteSchema], default: [], validate: (value) => value.length <= 200 },
  createdByUserId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, status: 1, nextFollowUpOn: 1 }, { name: 'lead_gym_followups' });
schema.index({ gymId: 1, phoneDigits: 1 }, { name: 'lead_gym_phone' });
schema.index({ gymId: 1, referredByMemberId: 1 }, { name: 'lead_gym_referrer' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'lead_gym_list' });

function getLeadModel(connection) { return connection.models.Lead || connection.model('Lead', schema); }
module.exports = { getLeadModel, statuses, sources, OPEN };
