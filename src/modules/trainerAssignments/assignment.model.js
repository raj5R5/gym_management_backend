const { Schema } = require('mongoose');
const { statuses } = require('./assignment.validation');
const schema = new Schema({
  gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, immutable: true },
  trainerId: { type: Schema.Types.ObjectId, ref: 'TrainerProfile', required: true, immutable: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'MemberProfile', required: true, immutable: true },
  status: { type: String, required: true, enum: statuses, default: 'active' },
  assignedAt: { type: Date, required: true, default: Date.now, immutable: true, validate: (value) => value <= new Date() },
  endedAt: { type: Date },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ gymId: 1, trainerId: 1, memberId: 1 }, { unique: true,
  partialFilterExpression: { status: 'active' }, name: 'assignment_active_relationship_unique' });
schema.index({ gymId: 1, createdAt: -1, _id: -1 }, { name: 'assignment_gym_list' });
schema.index({ gymId: 1, trainerId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'assignment_trainer_list' });
schema.index({ gymId: 1, memberId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'assignment_member_list' });
function getTrainerMemberAssignmentModel(connection) {
  return connection.models.TrainerMemberAssignment || connection.model('TrainerMemberAssignment', schema);
}
module.exports = { getTrainerMemberAssignmentModel };
