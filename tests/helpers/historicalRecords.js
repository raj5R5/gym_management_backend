const { Schema } = require('mongoose');
function historicalRecords(connection) {
  if (!connection) return;
  for (const [name, fields] of Object.entries({
    Branch: { gymId: Schema.Types.ObjectId, name: String, nameKey: String, status: { type: String, default: 'active' }, address: Schema.Types.Mixed },
    Attendance: { gymId: Schema.Types.ObjectId, memberId: Schema.Types.ObjectId, branchId: Schema.Types.ObjectId,
      subscriptionId: Schema.Types.ObjectId, recordedByUserId: Schema.Types.ObjectId, checkInAt: Date, checkOutAt: Date,
      status: { type: String, default: 'open' } },
  })) if (!connection.models[name]) connection.model(name, new Schema(fields, { strict: false, autoCreate: false, autoIndex: false }));
}
module.exports = { historicalRecords };
