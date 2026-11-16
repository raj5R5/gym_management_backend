const { nameKey } = require('../gyms/gym.service');
const { createBranch, summaryQuery, MAX_BRANCHES } = require('./branch.validation');

function fail(code) { const error = new Error('Branch operation failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }

function createBranchService({ Gym, GymAccess, MembershipPlan, authorizationService, dashboardService }) {
  /** Active gyms where this account is an active admin (the owner's branches). */
  async function ownedGyms(auth) {
    const grants = await GymAccess.find({ userId: auth.user._id, role: 'admin', status: 'active' }).select('gymId').lean();
    const gyms = await Gym.find({ _id: { $in: grants.map((grant) => grant.gymId) }, status: 'active' })
      .select('name settings contact createdAt').sort({ createdAt: 1, _id: 1 }).lean();
    return gyms;
  }

  return {
    async create(auth, input) {
      const data = parse(createBranch, input);
      const owned = await ownedGyms(auth);
      // Only existing gym owners can add branches; members and trainers cannot.
      if (!owned.length) fail('FORBIDDEN');
      if (owned.length >= MAX_BRANCHES) fail('BRANCH_LIMIT_REACHED');
      const source = data.fromGymId ? owned.find((gym) => String(gym._id) === data.fromGymId) : null;
      if (data.fromGymId && !source) fail('FORBIDDEN');
      const settings = data.copySettings && source?.settings ? Object.fromEntries(
        ['timezone', 'gstin', 'upiId', 'upiPayeeName'].filter((key) => source.settings[key] !== undefined)
          .map((key) => [key, source.settings[key]])) : undefined;
      const session = await Gym.db.startSession();
      let gymId;
      try {
        await session.withTransaction(async () => {
          const [gym] = await Gym.create([{ name: data.name, nameKey: nameKey(data.name), status: 'active',
            ...(source?.contact ? { contact: source.contact } : {}),
            ...(settings && Object.keys(settings).length ? { settings } : {}) }], { session });
          gymId = gym._id;
          await GymAccess.create([{ userId: auth.user._id, gymId, role: 'admin', status: 'active' }], { session });
          if (data.copyPlans && source) {
            const plans = await MembershipPlan.find({ gymId: source._id, status: 'active' }).session(session).lean();
            if (plans.length) {
              await MembershipPlan.create(plans.map((plan) => ({ gymId, name: plan.name, normalizedName: plan.normalizedName,
                durationDays: plan.durationDays, price: plan.price, status: 'active',
                ...(plan.description ? { description: plan.description } : {}) })), { session, ordered: true });
            }
          }
        });
      } catch (error) {
        if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
        if (error.code === 11000 && error.keyPattern?.nameKey) fail('DUPLICATE_GYM_NAME');
        throw error;
      } finally { await session.endSession(); }
      return { gymId: String(gymId), name: data.name };
    },

    /** Headline figures for every branch the owner administers. */
    async summary(auth, query) {
      const { preset } = parse(summaryQuery, query);
      const owned = await ownedGyms(auth);
      if (!owned.length) fail('FORBIDDEN');
      const dashboards = await Promise.all(owned.map(async (gym) => {
        const authorization = await authorizationService.requireGymAccess(auth, String(gym._id));
        return dashboardService.get(auth, authorization, preset === 'today' ? {} : { preset });
      }));
      const rows = owned.map((gym, index) => {
        const data = dashboards[index];
        return { gymId: String(gym._id), name: gym.name, activeMembers: data.subscriptions.currentlyActive,
          totalMembers: data.members.total, collectedPaise: data.payments.periodSuccessfulAmountPaise,
          duesPaise: data.payments.outstandingAmountPaise, expiringSoon: data.subscriptions.expiringSoon,
          checkInsToday: data.visits?.today ?? 0, expensesPaise: data.expenses?.periodAmountPaise ?? 0 };
      });
      const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
      return { preset, branches: rows, totals: { activeMembers: sum('activeMembers'), totalMembers: sum('totalMembers'),
        collectedPaise: sum('collectedPaise'), duesPaise: sum('duesPaise'), checkInsToday: sum('checkInsToday'),
        expensesPaise: sum('expensesPaise') } };
    },
  };
}
module.exports = { createBranchService };
