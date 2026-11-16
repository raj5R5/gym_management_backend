const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { photoFields } = require('../memberPhotos/photo.dto');
const { MAX_PRICE_PAISE } = require('../membershipPlans/plan.validation');
const { overviewQuery, birthdayQuery } = require('./overview.validation');

const DAY = 86_400_000;
// "Expiring" uses the same 7-day window as the dashboard membership overview.
const EXPIRING_DAYS = 7;
// "Inactive": an active membership but no visit for this many days (or never).
const INACTIVE_DAYS = 10;
// The overview is computed in memory; this bounds a single request for pilot-sized gyms.
const MAX_MEMBERS = 20_000;

function fail(code = 'INVALID_OVERVIEW_STATE') { const error = new Error('Member overview unavailable.'); error.code = code; throw error; }
function safePaise(value) { if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE_PAISE) fail('INVALID_FINANCIAL_STATE'); return value; }
const label = (date) => date.toISOString().slice(0, 10);

/** Classify one member from their non-cancelled subscriptions on the gym-local day `today`. */
function classify(subscriptions, paidBySubscription, today) {
  let balancePaise = 0, dueSubscriptionId = null, dueStart = null;
  let current = null, upcoming = null, latest = null;
  for (const sub of subscriptions) {
    const paid = paidBySubscription.get(String(sub._id)) ?? 0;
    const balance = safePaise(sub.pricePaiseSnapshot) - paid;
    if (balance > 0) {
      balancePaise += balance;
      if (!dueStart || sub.startDate < dueStart) { dueStart = sub.startDate; dueSubscriptionId = String(sub._id); }
    }
    if (sub.startDate <= today && sub.endDate > today) {
      if (!current || sub.startDate > current.startDate) current = sub;
    } else if (sub.startDate > today) {
      if (!upcoming || sub.startDate < upcoming.startDate) upcoming = sub;
    }
    if (!latest || sub.endDate > latest.endDate) latest = sub;
  }
  if (!Number.isSafeInteger(balancePaise)) fail('INVALID_FINANCIAL_STATE');
  const shown = current ?? upcoming ?? latest;
  let membership = null;
  if (shown) {
    const state = current ? 'active' : upcoming ? 'upcoming' : 'expired';
    // A later period already purchased means the member has renewed ahead of expiry.
    const renewedAhead = Boolean(current && subscriptions.some((sub) => sub.startDate >= current.endDate));
    const daysLeft = state === 'expired' ? 0 : Math.round((shown.endDate - today) / DAY);
    membership = { state, subscriptionId: String(shown._id), planName: shown.planNameSnapshot,
      membershipPlanId: String(shown.membershipPlanId), startDate: label(shown.startDate), endDate: label(shown.endDate),
      daysLeft, daysSinceExpiry: state === 'expired' ? Math.round((today - shown.endDate) / DAY) : 0,
      expiringSoon: state === 'active' && !renewedAhead && daysLeft <= EXPIRING_DAYS, renewedAhead };
  }
  return { membership, balancePaise, dueSubscriptionId };
}

function visitFields(last, today) {
  return last instanceof Date
    ? { lastVisitDate: label(last), daysSinceLastVisit: Math.max(0, Math.round((today - last) / DAY)) }
    : { lastVisitDate: null, daysSinceLastVisit: null };
}

function matches(row, filter) {
  switch (filter) {
    case 'active': return row.membership?.state === 'active';
    case 'expiring': return row.membership?.expiringSoon === true;
    case 'dues': return row.balancePaise > 0;
    case 'expired': return row.membership?.state === 'expired';
    case 'none': return row.membership === null;
    // Frozen members are away by agreement, not lapsing.
    case 'inactive': return row.membership?.state === 'active' && !row.membership.frozenUntil
      && (row.daysSinceLastVisit === null || row.daysSinceLastVisit >= INACTIVE_DAYS);
    default: return true;
  }
}

const byName = (a, b) => `${a.member.firstName} ${a.member.lastName}`.localeCompare(`${b.member.firstName} ${b.member.lastName}`, 'en', { sensitivity: 'base' })
  || a.member.id.localeCompare(b.member.id);
const sorters = {
  expiring: (a, b) => a.membership.daysLeft - b.membership.daysLeft || byName(a, b),
  dues: (a, b) => b.balancePaise - a.balancePaise || byName(a, b),
  expired: (a, b) => a.membership.daysSinceExpiry - b.membership.daysSinceExpiry || byName(a, b),
  // Longest absence first; members who never visited lead.
  inactive: (a, b) => (b.daysSinceLastVisit ?? Infinity) - (a.daysSinceLastVisit ?? Infinity) || byName(a, b),
};

/** Days from `today` to the next birthday; Feb 29 is celebrated on Feb 28 in other years. */
function nextBirthday(dob, today) {
  const year = today.getUTCFullYear();
  const on = (y) => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const month = dob.getUTCMonth(); let date = dob.getUTCDate();
    if (month === 1 && date === 29 && !leap) date = 28;
    return new Date(Date.UTC(y, month, date));
  };
  let next = on(year);
  if (next < today) next = on(year + 1);
  return { daysUntil: Math.round((next - today) / DAY), turning: next.getUTCFullYear() - dob.getUTCFullYear(), date: label(next) };
}

function createMemberOverviewService({ Gym, MemberProfile, MemberSubscription, Payment, MemberVisit, MembershipFreeze,
  authorizationService }) {
  return {
    /** Active members with a birthday in the next `days` gym-local days, soonest first. */
    async birthdays(auth, authorization, query) {
      authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
      const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
      authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
      const parsed = birthdayQuery.safeParse(query); if (!parsed.success) fail('VALIDATION_ERROR');
      const gymId = new Types.ObjectId(current.gymId);
      const calendar = await gymCalendar(Gym, gymId);
      const members = await MemberProfile.find({ gymId, status: 'active', dateOfBirth: { $exists: true } })
        .select('gymId memberCode firstName lastName phone status dateOfBirth photoUrl photoPublicId photoRevision').lean();
      const data = members.map((member) => ({ member: { ...photoFields(member), id: String(member._id),
        memberCode: member.memberCode, firstName: member.firstName, lastName: member.lastName, phone: member.phone,
        status: member.status }, ...nextBirthday(member.dateOfBirth, calendar.day) }))
        .filter((row) => row.daysUntil <= parsed.data.days)
        .sort((a, b) => a.daysUntil - b.daysUntil || a.member.firstName.localeCompare(b.member.firstName));
      return { today: calendar.label, days: parsed.data.days, data };
    },
    async list(auth, authorization, query) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    const parsed = overviewQuery.safeParse(query); if (!parsed.success) fail('VALIDATION_ERROR');
    const { page, limit, filter, search } = parsed.data;
    const gymId = new Types.ObjectId(current.gymId);
    const calendar = await gymCalendar(Gym, gymId);

    const [members, subscriptions, payments, visits, freezes] = await Promise.all([
      MemberProfile.find({ gymId }).select('gymId memberCode firstName lastName phone status photoUrl photoPublicId photoRevision')
        .limit(MAX_MEMBERS + 1).lean(),
      MemberSubscription.find({ gymId, status: { $ne: 'cancelled' } })
        .select('memberId membershipPlanId planNameSnapshot pricePaiseSnapshot startDate endDate').lean(),
      Payment.aggregate([{ $match: { gymId, status: 'succeeded' } },
        { $group: { _id: '$subscriptionId', amount: { $sum: '$amountPaise' } } }]),
      MemberVisit ? MemberVisit.aggregate([{ $match: { gymId } },
        { $group: { _id: '$memberId', last: { $max: '$visitDate' } } }]) : [],
      // Freezes covering today; an early-ended freeze ends today and is excluded.
      MembershipFreeze ? MembershipFreeze.find({ gymId, status: 'scheduled', startDate: { $lte: calendar.day },
        endDate: { $gt: calendar.day } }).select('memberId subscriptionId endDate').lean() : [],
    ]);
    const frozen = new Map(freezes.map((freeze) => [String(freeze.subscriptionId), label(freeze.endDate)]));
    const lastVisit = new Map(visits.map((row) => [String(row._id), row.last]));
    if (members.length > MAX_MEMBERS) fail('OVERVIEW_TOO_LARGE');
    const paid = new Map(payments.map((row) => [String(row._id), row.amount]));
    for (const amount of paid.values()) if (!Number.isSafeInteger(amount) || amount < 0) fail('INVALID_FINANCIAL_STATE');
    const byMember = new Map();
    for (const sub of subscriptions) {
      const key = String(sub.memberId);
      if (!byMember.has(key)) byMember.set(key, []);
      byMember.get(key).push(sub);
    }

    const rows = members.map((member) => {
      const row = { member: { ...photoFields(member), id: String(member._id), memberCode: member.memberCode,
        firstName: member.firstName, lastName: member.lastName, phone: member.phone, status: member.status },
      ...classify(byMember.get(String(member._id)) ?? [], paid, calendar.day),
      ...visitFields(lastVisit.get(String(member._id)), calendar.day) };
      if (row.membership) row.membership.frozenUntil = frozen.get(row.membership.subscriptionId) ?? null;
      return row;
    });
    const counts = { all: rows.length, active: 0, expiring: 0, dues: 0, expired: 0, none: 0, inactive: 0 };
    let duesTotalPaise = 0;
    for (const row of rows) {
      for (const key of ['active', 'expiring', 'dues', 'expired', 'none', 'inactive']) if (matches(row, key)) counts[key] += 1;
      duesTotalPaise += row.balancePaise;
    }
    if (!Number.isSafeInteger(duesTotalPaise)) fail('INVALID_FINANCIAL_STATE');

    const needle = search?.toLowerCase();
    const selected = rows.filter((row) => matches(row, filter) && (!needle
      || [row.member.memberCode, row.member.firstName, row.member.lastName, `${row.member.firstName} ${row.member.lastName}`, row.member.phone]
        .some((value) => value?.toLowerCase().includes(needle))))
      .sort(sorters[filter] ?? byName);
    return { calendar: { timezone: calendar.timezone, today: calendar.label }, counts, duesTotalPaise, filter,
      data: selected.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: selected.length } };
    },
  };
}
module.exports = { createMemberOverviewService, classify, nextBirthday, EXPIRING_DAYS, INACTIVE_DAYS };
