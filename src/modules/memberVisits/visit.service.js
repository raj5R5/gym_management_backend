const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { photoFields } = require('../memberPhotos/photo.dto');
const { classify } = require('../memberOverview/overview.service');
const { objectId } = require('../gyms/gym.validation');
const { checkIn, visitListQuery } = require('./visit.validation');

const DAY = 86_400_000;
function fail(code, details) {
  const error = new Error('Visit operation failed.'); error.code = code;
  if (details) error.details = details;
  throw error;
}
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const label = (date) => date.toISOString().slice(0, 10);
function memberDto(member) {
  return { ...photoFields(member), id: String(member._id), memberCode: member.memberCode,
    firstName: member.firstName, lastName: member.lastName, phone: member.phone, status: member.status };
}
function visitDto(visit) {
  return { id: String(visit._id), memberId: String(visit.memberId), visitDate: label(visit.visitDate),
    checkedInAt: visit.checkedInAt.toISOString(), method: visit.method,
    membershipState: visit.membershipState, override: visit.override };
}

function createMemberVisitService({ Gym, MemberProfile, MemberSubscription, Payment, MemberVisit, MembershipFreeze,
  authorizationService, clock = () => new Date() }) {
  let indexes;
  // Models never auto-index; the unique per-day index is what makes check-in idempotent.
  const ensureIndexes = () => (indexes ??= MemberVisit.createIndexes().catch((error) => { indexes = undefined; throw error; }));

  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return new Types.ObjectId(current.gymId);
  }
  async function memberFor(gymId, memberId) {
    const member = await MemberProfile.findOne({ _id: parse(objectId, memberId), gymId })
      .select('gymId memberCode firstName lastName phone status photoUrl photoPublicId photoRevision').lean();
    if (!member) fail('MEMBER_NOT_FOUND');
    return member;
  }
  async function membershipFor(gymId, memberId, day) {
    const [subs, payments] = await Promise.all([
      MemberSubscription.find({ gymId, memberId, status: { $ne: 'cancelled' } })
        .select('memberId membershipPlanId planNameSnapshot pricePaiseSnapshot startDate endDate').lean(),
      Payment.aggregate([{ $match: { gymId, memberId, status: 'succeeded' } },
        { $group: { _id: '$subscriptionId', amount: { $sum: '$amountPaise' } } }]),
    ]);
    return classify(subs, new Map(payments.map((row) => [String(row._id), row.amount])), day);
  }

  return {
    async checkIn(auth, authorization, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(checkIn, input);
      const member = await memberFor(gymId, data.memberId);
      if (member.status !== 'active') fail('MEMBER_NOT_ACTIVE');
      const now = clock();
      const calendar = await gymCalendar(Gym, gymId, now);
      const overview = await membershipFor(gymId, member._id, calendar.day);
      const freeze = overview.membership?.state === 'active' && MembershipFreeze
        ? await MembershipFreeze.findOne({ gymId, subscriptionId: overview.membership.subscriptionId, status: 'scheduled',
          startDate: { $lte: calendar.day }, endDate: { $gt: calendar.day } }).select('endDate').lean()
        : null;
      // A frozen membership is paused: entering needs the same explicit override.
      const state = freeze ? 'frozen' : overview.membership?.state ?? 'none';
      const result = { member: memberDto(member), membership: overview.membership, balancePaise: overview.balancePaise };
      const existing = await MemberVisit.findOne({ gymId, memberId: member._id, visitDate: calendar.day }).lean();
      if (existing) return { ...result, visit: visitDto(existing), alreadyCheckedIn: true };
      if (state !== 'active' && !data.override) {
        fail('MEMBERSHIP_NOT_ACTIVE', { membershipState: state, planName: overview.membership?.planName ?? null,
          endDate: overview.membership?.endDate ?? null,
          ...(freeze ? { frozenUntil: freeze.endDate.toISOString().slice(0, 10) } : {}) });
      }
      await ensureIndexes();
      try {
        const visit = await MemberVisit.create({ gymId, memberId: member._id, recordedByUserId: auth.user._id,
          visitDate: calendar.day, checkedInAt: now, method: data.method, membershipState: state,
          override: state !== 'active' });
        return { ...result, visit: visitDto(visit.toObject()), alreadyCheckedIn: false };
      } catch (error) {
        // A concurrent check-in for the same member and day won the race: return it.
        if (error.code !== 11000) throw error;
        const winner = await MemberVisit.findOne({ gymId, memberId: member._id, visitDate: calendar.day }).lean();
        if (!winner) throw error;
        return { ...result, visit: visitDto(winner), alreadyCheckedIn: true };
      }
    },

    async today(auth, authorization, query) {
      const gymId = await scope(auth, authorization);
      const { page, limit } = parse(visitListQuery, query);
      const calendar = await gymCalendar(Gym, gymId, clock());
      const filter = { gymId, visitDate: calendar.day };
      const [visits, total, overrides] = await Promise.all([
        MemberVisit.find(filter).sort({ checkedInAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        MemberVisit.countDocuments(filter),
        MemberVisit.countDocuments({ ...filter, override: true }),
      ]);
      const members = new Map((await MemberProfile.find({ gymId, _id: { $in: visits.map((visit) => visit.memberId) } })
        .select('gymId memberCode firstName lastName phone status photoUrl photoPublicId photoRevision').lean())
        .map((member) => [String(member._id), member]));
      return { date: calendar.label, timezone: calendar.timezone, total, overrides,
        data: visits.filter((visit) => members.has(String(visit.memberId)))
          .map((visit) => ({ visit: visitDto(visit), member: memberDto(members.get(String(visit.memberId))) })),
        pagination: { page, limit, total } };
    },

    async memberHistory(auth, authorization, memberId, query) {
      const gymId = await scope(auth, authorization);
      const { page, limit } = parse(visitListQuery, query);
      const member = await memberFor(gymId, memberId);
      const calendar = await gymCalendar(Gym, gymId, clock());
      const since = new Date(calendar.day.getTime() - 29 * DAY);
      const filter = { gymId, memberId: member._id };
      const [visits, total, last30Days, latest] = await Promise.all([
        MemberVisit.find(filter).sort({ checkedInAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        MemberVisit.countDocuments(filter),
        MemberVisit.countDocuments({ ...filter, visitDate: { $gte: since, $lte: calendar.day } }),
        MemberVisit.findOne(filter).sort({ visitDate: -1 }).select('visitDate').lean(),
      ]);
      return { memberId: String(member._id), today: calendar.label, visitsLast30Days: last30Days,
        lastVisitDate: latest ? label(latest.visitDate) : null,
        daysSinceLastVisit: latest ? Math.round((calendar.day - latest.visitDate) / DAY) : null,
        data: visits.map(visitDto), pagination: { page, limit, total } };
    },
  };
}
module.exports = { createMemberVisitService };
