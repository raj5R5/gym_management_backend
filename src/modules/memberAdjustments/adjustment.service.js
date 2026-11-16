const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { objectId } = require('../gyms/gym.validation');
const { FREEZE_RULES, createFreeze, createDiscount } = require('./adjustment.validation');

const DAY = 86_400_000;
function fail(code, details) {
  const error = new Error('Membership adjustment failed.'); error.code = code;
  if (details) error.details = details;
  throw error;
}
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const label = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * DAY);
const daysBetween = (from, to) => Math.round((to - from) / DAY);

function freezeDto(freeze, today) {
  const current = freeze.status === 'scheduled' && freeze.startDate <= today && freeze.endDate > today;
  return { id: String(freeze._id), startDate: label(freeze.startDate), endDate: label(freeze.endDate),
    days: freeze.days, status: freeze.endDate <= today ? 'finished' : current ? 'current' : freeze.status === 'ended' ? 'ended' : 'upcoming',
    reason: freeze.reason ?? null, endedEarly: freeze.status === 'ended' };
}
function discountDto(discount) {
  return { id: String(discount._id), amountPaise: discount.amountPaise, percent: discount.percent ?? null,
    reason: discount.reason ?? null, createdAt: discount.createdAt };
}

/** Why a membership cannot be frozen now, or null when it can. */
function freezeBlocker(subscription, today, hasRenewalAfter) {
  if (subscription.status === 'cancelled') return 'cancelled';
  if (subscription.durationDaysSnapshot < FREEZE_RULES.minPlanDays) return 'plan_too_short';
  if (subscription.endDate <= today) return 'ended';
  if (hasRenewalAfter) return 'renewal_queued';
  if ((subscription.frozenDays ?? 0) >= FREEZE_RULES.maxTotalDays) return 'no_days_left';
  return null;
}

function createAdjustmentService({ Gym, MemberSubscription, Payment, MembershipFreeze, MembershipDiscount,
  authorizationService, clock = () => new Date() }) {
  let indexes;
  const ensureIndexes = () => (indexes ??= Promise.all([MembershipFreeze.createIndexes(), MembershipDiscount.createIndexes()])
    .catch((error) => { indexes = undefined; throw error; }));

  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return new Types.ObjectId(current.gymId);
  }
  async function transaction(work) {
    const session = await MemberSubscription.db.startSession();
    try { return await session.withTransaction(() => work(session)); }
    catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
      throw error;
    } finally { await session.endSession(); }
  }
  async function subscriptionFor(gymId, subscriptionId, session) {
    const sub = await MemberSubscription.findOne({ _id: parse(objectId, subscriptionId), gymId }).session(session ?? null).lean();
    if (!sub) fail('SUBSCRIPTION_NOT_FOUND');
    return sub;
  }
  const renewalAfter = (gymId, sub, session) => MemberSubscription.exists({ gymId, memberId: sub.memberId,
    _id: { $ne: sub._id }, status: { $ne: 'cancelled' }, startDate: { $gte: sub.endDate } }).session(session ?? null);
  async function paidFor(gymId, sub, session) {
    const [row] = await Payment.aggregate([{ $match: { gymId, subscriptionId: sub._id, status: 'succeeded' } },
      { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]).session(session ?? null);
    return row?.amount ?? 0;
  }
  // Optimistic move: only applies if nobody else changed the dates or price meanwhile.
  async function apply(sub, update, session) {
    // Memberships created before Phase 3b have no counters stored: match missing as 0.
    const counter = (value) => (value === undefined || value === 0 ? { $in: [0, null] } : value);
    const result = await MemberSubscription.updateOne({ _id: sub._id, gymId: sub.gymId, endDate: sub.endDate,
      frozenDays: counter(sub.frozenDays), pricePaiseSnapshot: sub.pricePaiseSnapshot, discountPaise: counter(sub.discountPaise) },
    update, { session, runValidators: true, membershipAdjustment: true });
    if (result.modifiedCount !== 1) fail('ADJUSTMENT_CONFLICT');
  }

  async function summary(gymId, subscriptionId) {
    const sub = await subscriptionFor(gymId, subscriptionId);
    const { day: today } = await gymCalendar(Gym, gymId, clock());
    const [freezes, discounts, renewal, paid] = await Promise.all([
      MembershipFreeze.find({ gymId, subscriptionId: sub._id }).sort({ startDate: 1, _id: 1 }).lean(),
      MembershipDiscount.find({ gymId, subscriptionId: sub._id }).sort({ createdAt: 1, _id: 1 }).lean(),
      renewalAfter(gymId, sub), paidFor(gymId, sub),
    ]);
    const blocker = freezeBlocker(sub, today, Boolean(renewal));
    const frozenDays = sub.frozenDays ?? 0; const discountPaise = sub.discountPaise ?? 0;
    return { subscriptionId: String(sub._id), today: label(today), startDate: label(sub.startDate), endDate: label(sub.endDate),
      durationDays: sub.durationDaysSnapshot, frozenDays, listPricePaise: sub.pricePaiseSnapshot + discountPaise,
      discountPaise, pricePaise: sub.pricePaiseSnapshot, paidPaise: paid, balancePaise: Math.max(0, sub.pricePaiseSnapshot - paid),
      freeze: { allowed: blocker === null, blocker, daysLeft: Math.max(0, FREEZE_RULES.maxTotalDays - frozenDays),
        maxTotalDays: FREEZE_RULES.maxTotalDays, minPlanDays: FREEZE_RULES.minPlanDays,
        earliestStart: label(today), latestStart: label(addDays(sub.endDate, -1)) },
      freezes: freezes.map((freeze) => freezeDto(freeze, today)), discounts: discounts.map(discountDto) };
  }

  return {
    async get(auth, authorization, subscriptionId) {
      return summary(await scope(auth, authorization), subscriptionId);
    },

    async freeze(auth, authorization, subscriptionId, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(createFreeze, input);
      await ensureIndexes();
      await transaction(async (session) => {
        const sub = await subscriptionFor(gymId, subscriptionId, session);
        const { day: today } = await gymCalendar(Gym, gymId, clock(), session);
        const blocker = freezeBlocker(sub, today, Boolean(await renewalAfter(gymId, sub, session)));
        if (blocker) fail('FREEZE_NOT_ALLOWED', { blocker });
        const start = new Date(`${data.startDate}T00:00:00.000Z`);
        // Today or later, and it must begin while the membership still runs.
        if (start < today || start >= sub.endDate) fail('FREEZE_NOT_ALLOWED', { blocker: 'start_out_of_range' });
        const remaining = FREEZE_RULES.maxTotalDays - (sub.frozenDays ?? 0);
        if (data.days > remaining) fail('FREEZE_NOT_ALLOWED', { blocker: 'too_many_days', daysLeft: remaining });
        const end = addDays(start, data.days);
        // Zero-day records (freezes cancelled before they began) never block.
        const overlap = await MembershipFreeze.exists({ gymId, subscriptionId: sub._id, days: { $gt: 0 },
          startDate: { $lt: end }, endDate: { $gt: start } }).session(session);
        if (overlap) fail('FREEZE_OVERLAP');
        await apply(sub, { $set: { endDate: addDays(sub.endDate, data.days), frozenDays: (sub.frozenDays ?? 0) + data.days } }, session);
        await MembershipFreeze.create([{ gymId, memberId: sub.memberId, subscriptionId: sub._id, recordedByUserId: auth.user._id,
          startDate: start, endDate: end, days: data.days, ...(data.reason ? { reason: data.reason } : {}) }], { session });
      });
      return summary(gymId, subscriptionId);
    },

    async endFreeze(auth, authorization, subscriptionId, freezeId) {
      const gymId = await scope(auth, authorization);
      const id = parse(objectId, freezeId);
      await transaction(async (session) => {
        const sub = await subscriptionFor(gymId, subscriptionId, session);
        const freeze = await MembershipFreeze.findOne({ _id: id, gymId, subscriptionId: sub._id }).session(session).lean();
        if (!freeze) fail('FREEZE_NOT_FOUND');
        const { day: today } = await gymCalendar(Gym, gymId, clock(), session);
        if (freeze.status !== 'scheduled' || freeze.endDate <= today) fail('FREEZE_NOT_ALLOWED', { blocker: 'freeze_finished' });
        // Moving the membership end earlier must not strand a later freeze.
        const later = await MembershipFreeze.exists({ gymId, subscriptionId: sub._id, _id: { $ne: freeze._id },
          status: 'scheduled', startDate: { $gte: freeze.endDate } }).session(session);
        if (later) fail('FREEZE_NOT_ALLOWED', { blocker: 'later_freeze' });
        const newEnd = freeze.startDate > today ? freeze.startDate : today;
        const returned = daysBetween(newEnd, freeze.endDate);
        await apply(sub, { $set: { endDate: addDays(sub.endDate, -returned), frozenDays: (sub.frozenDays ?? 0) - returned } }, session);
        await MembershipFreeze.updateOne({ _id: freeze._id, status: 'scheduled' }, { $set: { endDate: newEnd,
          days: freeze.days - returned, status: 'ended', endedEarlyAt: clock(), endedEarlyByUserId: auth.user._id } },
        { session, runValidators: true });
      });
      return summary(gymId, subscriptionId);
    },

    async discount(auth, authorization, subscriptionId, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(createDiscount, input);
      await ensureIndexes();
      await transaction(async (session) => {
        const sub = await subscriptionFor(gymId, subscriptionId, session);
        if (sub.status === 'cancelled') fail('SUBSCRIPTION_CANCELLED');
        const listPrice = sub.pricePaiseSnapshot + (sub.discountPaise ?? 0);
        // Percent applies to the plan's list price, rounded to the nearest paisa.
        const amount = data.amountPaise ?? Math.round(listPrice * data.percent / 100);
        const balance = sub.pricePaiseSnapshot - await paidFor(gymId, sub, session);
        if (amount < 1) fail('VALIDATION_ERROR');
        if (amount > balance) fail('DISCOUNT_EXCEEDS_BALANCE', { balancePaise: Math.max(0, balance), amountPaise: amount });
        await apply(sub, { $set: { pricePaiseSnapshot: sub.pricePaiseSnapshot - amount,
          discountPaise: (sub.discountPaise ?? 0) + amount } }, session);
        await MembershipDiscount.create([{ gymId, memberId: sub.memberId, subscriptionId: sub._id, recordedByUserId: auth.user._id,
          amountPaise: amount, ...(data.percent ? { percent: data.percent } : {}), ...(data.reason ? { reason: data.reason } : {}) }],
        { session });
      });
      return summary(gymId, subscriptionId);
    },
  };
}
module.exports = { createAdjustmentService, freezeBlocker };
