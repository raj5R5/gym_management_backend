const { Schema } = require('mongoose');
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  gymId: { type: Schema.Types.ObjectId, required: true },
  phone: { type: String, trim: true, maxlength: 25 },
  photoUrl: String,
  photoPublicId: String,
  photoRevision: { type: Number, default: 0, min: 0 },
}, { timestamps: true, strict: 'throw', bufferCommands: false, autoCreate: false, autoIndex: false });
schema.index({ userId: 1, gymId: 1 }, { unique: true, name: 'owner_profile_scope_unique' });
function getOwnerProfileModel(connection) {
  return connection.models.OwnerProfile || connection.model('OwnerProfile', schema);
}
module.exports = { getOwnerProfileModel };
