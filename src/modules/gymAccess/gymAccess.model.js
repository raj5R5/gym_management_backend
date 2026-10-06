const { Schema } = require('mongoose');
const { roles, accessStatuses } = require('./gymAccess.validation');

const gymAccessSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'UserAccount', required: true, immutable: true },
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  role: { type: String, enum: roles, required: true },
  status: { type: String, enum: accessStatuses, required: true, default: 'inactive' },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
gymAccessSchema.index({ userId: 1, gymId: 1 }, { unique: true, name: 'access_user_gym_unique' });
gymAccessSchema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'access_gym_list' });

function getGymAccessModel(connection) {
  return connection.models.GymAccess || connection.model('GymAccess', gymAccessSchema);
}

module.exports = { getGymAccessModel };
