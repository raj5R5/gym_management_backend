const { createHash } = require('node:crypto');
const { z } = require('zod');
const { objectId } = require('../gyms/gym.validation');
const { digestToken } = require('../auth/tokens');
const choices = z.array(z.discriminatedUnion('kind', [
  z.strictObject({ gymId: objectId, kind: z.literal('leave') }),
  z.strictObject({ gymId: objectId, kind: z.literal('close') }),
  z.strictObject({ gymId: objectId, kind: z.literal('transfer'), successorId: objectId }),
])).max(50).refine((rows) => new Set(rows.map((r) => r.gymId)).size === rows.length);
function fail(code) { const error = new Error('Account deletion could not proceed.'); error.code = code; throw error; }
function parseChoices(value) { const parsed = choices.safeParse(value); if (!parsed.success) fail('VALIDATION_ERROR'); return parsed.data; }
// Every registered collection holding a gym's own records. Closure purges all of
// them; photo cleanup queues are drained separately so provider assets are removed.
const gymModels = ['TrainerMemberAssignment', 'Payment', 'MemberSubscription', 'RenewalOperation',
  'MemberOnboardingOperation', 'MemberActivation', 'MembershipPlan', 'TrainerProfile', 'MemberProfile',
  'MemberPhotoOperation', 'OwnerPhotoOperation', 'OwnerProfile', 'GymAccess'];
// Retired features whose historical rows remain in MongoDB without a registered model.
const legacyCollections = ['attendances', 'branches'];
const summaryModels = ['MemberProfile', 'TrainerProfile', 'MembershipPlan', 'MemberSubscription', 'Payment', 'GymAccess'];
const pending = { state: { $in: ['prepared', 'uploading'] } };
const usable = { status: 'active', passwordHash: { $exists: true, $type: 'string', $ne: '' } };

async function activeAdmins(models, gymId, userId, session) {
  const grants = await models.GymAccess.find({ gymId, userId: { $ne: userId }, role: 'admin', status: 'active' })
    .session(session ?? null).select('userId').lean();
  return models.UserAccount.find({ _id: { $in: grants.map((g) => g.userId) }, ...usable })
    .session(session ?? null).select('_id credentialVersion').sort({ _id: 1 }).lean();
}

// Lists what the departing account may choose for each gym. Read-only.
async function deletionOptions(models, userId) {
  const grants = await models.GymAccess.find({ userId }).sort({ _id: 1 }).lean();
  const gyms = [];
  for (const grant of grants) {
    const gym = await models.Gym.findById(grant.gymId).select('name status').lean();
    const owner = grant.role === 'admin' && grant.status === 'active';
    const admins = owner ? await activeAdmins(models, grant.gymId, userId) : [];
    const staff = owner && !admins.length ? await models.GymAccess.find({ gymId: grant.gymId, userId: { $ne: userId },
      role: { $in: ['admin', 'trainer'] }, status: 'active' }).select('userId role').lean() : [];
    const accounts = await models.UserAccount.find({ _id: { $in: staff.map((g) => g.userId) }, ...usable })
      .select('displayName email').sort({ _id: 1 }).lean();
    gyms.push({ gymId: String(grant.gymId), gymName: gym?.name ?? null, role: grant.role,
      choices: !owner || admins.length ? ['leave'] : accounts.length ? ['close', 'transfer'] : ['close'],
      successors: accounts.map((a) => ({ userId: String(a._id), name: a.displayName || a.email,
        role: staff.find((g) => String(g.userId) === String(a._id)).role })) });
  }
  return gyms;
}

// Binds a confirmation to the account-related state inspected now. Ordinary staff
// edits to members/payments do not invalidate it; ownership and contact changes do.
async function inspectScope(models, userId, actions, session) {
  const { UserAccount, GymAccess, Gym } = models;
  const s = session ?? null;
  const user = await UserAccount.findById(userId).session(s).lean();
  if (!user || user.status !== 'active') fail('INVALID_AUTHENTICATION');
  const grants = await GymAccess.find({ userId }).sort({ _id: 1 }).session(s).lean();
  const ids = grants.map((g) => String(g.gymId)).sort();
  if (JSON.stringify(ids) !== JSON.stringify(actions.map((a) => String(a.gymId)).sort())) fail('DELETION_SCOPE_INVALID');
  if (await models.DeletionFulfillment.exists({ userId }).session(s)) fail('DELETION_EXISTING_REVIEW_REQUIRED');
  if (await models.MemberPhotoOperation.exists({ actorId: userId, ...pending }).session(s)) fail('DELETION_PENDING_OPERATIONS');
  const ownerProfiles = await models.OwnerProfile.find({ userId }).session(s).select('_id gymId').lean();
  if (ownerProfiles.some((p) => !ids.includes(String(p.gymId)))) fail('DELETION_SCOPE_INVALID');
  if (await models.OwnerPhotoOperation.exists({ actorId: userId, memberId: { $nin: ownerProfiles.map((p) => p._id) } }).session(s)) fail('DELETION_SCOPE_INVALID');
  const snapshot = { user: { id: String(user._id), version: user.credentialVersion ?? 0, email: user.email, displayName: user.displayName },
    grants: grants.map((g) => [String(g._id), String(g.gymId), g.role, g.status]), gyms: [] };
  const plan = [], entries = [];
  for (const action of [...actions].sort((a, b) => String(a.gymId).localeCompare(String(b.gymId)))) {
    const gym = await Gym.findById(action.gymId).session(s).lean();
    if (!gym || gym.status !== 'active') fail('DELETION_SCOPE_CHANGED');
    const grant = grants.find((g) => String(g.gymId) === String(gym._id));
    const owner = grant.role === 'admin' && grant.status === 'active';
    const ownProfiles = await models.OwnerProfile.find({ userId, gymId: gym._id }).session(s).sort({ _id: 1 }).lean();
    const ownOps = await models.OwnerPhotoOperation.find({ memberId: { $in: ownProfiles.map((p) => p._id) } }).session(s).sort({ _id: 1 }).lean();
    if (ownOps.some((op) => ['prepared', 'uploading'].includes(op.state))) fail('DELETION_PENDING_OPERATIONS');
    const admins = await activeAdmins(models, gym._id, userId, session);
    const entry = { gym, grant, ownProfiles, ownOps, admins, successor: null, counts: null,
      action: { gymId: String(gym._id), kind: action.kind, successorId: action.successorId ? String(action.successorId) : null } };
    if (!owner && action.kind !== 'leave') fail('DELETION_SCOPE_INVALID');
    if (owner && action.kind === 'leave' && !admins.length) fail('DELETION_OWNERSHIP_HANDOFF_REQUIRED');
    if (action.kind === 'transfer') {
      if (String(action.successorId) === String(userId)) fail('DELETION_SCOPE_INVALID');
      const held = await GymAccess.exists({ gymId: gym._id, userId: action.successorId, status: 'active', role: { $in: ['admin', 'trainer'] } }).session(s);
      entry.successor = held && await UserAccount.findOne({ _id: action.successorId, ...usable }).session(s).select('_id credentialVersion').lean();
      if (!entry.successor) fail('DELETION_OWNERSHIP_HANDOFF_REQUIRED');
    }
    if (action.kind === 'close') {
      // Closing a gym other owners still run would delete their business; they must leave instead.
      if (await GymAccess.exists({ gymId: gym._id, userId: { $ne: userId }, role: 'admin', status: 'active' }).session(s)) fail('DELETION_OTHER_OWNERS_PRESENT');
      if (await models.MemberPhotoOperation.exists({ gymId: gym._id, ...pending }).session(s)
        || await models.OwnerPhotoOperation.exists({ gymId: gym._id, ...pending }).session(s)) fail('DELETION_PENDING_OPERATIONS');
      entry.counts = {};
      for (const name of summaryModels) entry.counts[name] = await models[name].countDocuments({ gymId: gym._id }).session(s);
    }
    snapshot.gyms.push({ gym: [String(gym._id), gym.status, gym.contact ?? null],
      grant: [grant.role, grant.status], action: entry.action,
      ownProfiles: ownProfiles.map((p) => [String(p._id), p.phone ?? null, p.photoPublicId ?? null, p.photoRevision ?? 0]),
      ownOps: ownOps.map((op) => [String(op._id), op.state, op.publicId ?? null]),
      admins: admins.map((a) => [String(a._id), a.credentialVersion ?? 0]),
      successor: entry.successor ? [String(entry.successor._id), entry.successor.credentialVersion ?? 0] : null });
    entries.push(entry);
    plan.push({ gymId: String(gym._id), gymName: gym.name, kind: action.kind,
      successorId: action.successorId ? String(action.successorId) : undefined,
      consequences: action.kind === 'close'
        ? 'Permanently delete this gym and all of its records: members, trainers, plans, memberships, payments, assignments and photos. Other people lose access to this gym. Keep any records you need before confirming; MuscleDesk will not keep a copy.'
        : action.kind === 'transfer'
          ? 'The selected staff account must accept ownership. That account becomes an administrator; gym records remain. Your account and owner profile will be removed.'
          : owner ? 'Other active owners keep access and the gym records. Your account and owner profile will be removed; payments you recorded stay with the gym without a link to you.'
            : 'You leave this gym. Its member or trainer record about you stays with the gym, unlinked from your deleted login.',
      ...(entry.counts ? { counts: entry.counts } : {}) });
  }
  // No personal snapshot is persisted; it is used only to bind confirmation to the inspected scope.
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { user, grants, entries, plan, digest };
}

async function queueAssets(Model, rows, field, session, now) {
  const keys = [];
  for (const row of rows) {
    const publicId = row[field]; if (!publicId) continue;
    const key = digestToken(publicId); keys.push(key);
    await Model.updateOne({ _id: key }, { $setOnInsert: { publicId, gymId: row.gymId, after: now } }, { upsert: true, session });
  }
  return [...new Set(keys)];
}
module.exports = { parseChoices, inspectScope, deletionOptions, queueAssets, fail, gymModels, legacyCollections };
