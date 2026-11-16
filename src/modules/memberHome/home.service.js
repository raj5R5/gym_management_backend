const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { classify } = require('../memberOverview/overview.service');

const DAY = 86_400_000;
// Enough history for this month's count and a long weekly streak.
const VISIT_WINDOW_DAYS = 400;
const label = (date) => date.toISOString().slice(0, 10);
// Monday of the week containing a UTC-midnight calendar day.
const weekStart = (day) => new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);

/** Consecutive Monday-start weeks with a visit, counting back from this week
 * (or from last week, so the streak survives until this week is over). */
function weekStreak(visitDays, today) {
  const weeks = new Set(visitDays.map((day) => weekStart(day).getTime()));
  let cursor = weekStart(today).getTime();
  if (!weeks.has(cursor)) cursor -= 7 * DAY;
  let streak = 0;
  while (weeks.has(cursor)) { streak += 1; cursor -= 7 * DAY; }
  return streak;
}

/** Everything the member app's home shows, in one read for the signed-in member. */
function createMemberHomeService({ Gym, MemberSubscription, Payment, MemberVisit, MembershipFreeze, PtPackage, TrainerProfile,
  PaymentClaim, receiptService, resolveSelfMember }) {
  return {
    async home(auth, authorization) {
      const member = await resolveSelfMember(auth, authorization);
      const gymId = new Types.ObjectId(member.gymId);
      const calendar = await gymCalendar(Gym, gymId);
      const today = calendar.day;
      const [gym, subscriptions, paid, visits, freeze, packages, pendingClaims] = await Promise.all([
        Gym.findOne({ _id: gymId }).select('name contact settings.upiId settings.upiPayeeName settings.address').lean(),
        MemberSubscription.find({ gymId, memberId: member._id, status: { $ne: 'cancelled' } })
          .select('membershipPlanId planNameSnapshot pricePaiseSnapshot startDate endDate').lean(),
        Payment.aggregate([{ $match: { gymId, memberId: member._id, status: 'succeeded' } },
          { $group: { _id: '$subscriptionId', amount: { $sum: '$amountPaise' } } }]),
        MemberVisit.find({ gymId, memberId: member._id, visitDate: { $gte: new Date(today.getTime() - VISIT_WINDOW_DAYS * DAY) } })
          .sort({ visitDate: -1 }).select('visitDate').lean(),
        MembershipFreeze.findOne({ gymId, memberId: member._id, status: 'scheduled', startDate: { $lte: today },
          endDate: { $gt: today } }).select('endDate').lean(),
        PtPackage.find({ gymId, memberId: member._id, status: 'active' }).sort({ createdAt: -1 }).limit(10).lean(),
        PaymentClaim.aggregate([{ $match: { gymId, memberId: member._id, status: 'pending' } },
          { $group: { _id: null, amount: { $sum: '$amountPaise' }, count: { $sum: 1 } } }]),
      ]);
      const { membership, balancePaise, dueSubscriptionId } = classify(subscriptions,
        new Map(paid.map((row) => [String(row._id), row.amount])), today);
      const trainers = new Map((await TrainerProfile.find({ gymId, _id: { $in: packages.map((pkg) => pkg.trainerId) } })
        .select('firstName lastName').lean()).map((t) => [String(t._id), `${t.firstName} ${t.lastName}`]));
      const days = visits.map((visit) => visit.visitDate);
      const monthStart = `${calendar.label.slice(0, 7)}-01`;
      const address = gym?.settings?.address;
      return {
        today: calendar.label,
        gym: { name: gym?.name ?? '', phone: gym?.contact?.phone ?? null,
          address: address ? [address.line1, address.line2, address.city, address.state, address.postalCode]
            .filter(Boolean).join(', ') : null,
          upiId: gym?.settings?.upiId ?? null, upiPayeeName: gym?.settings?.upiPayeeName ?? null },
        member: { id: String(member._id), memberCode: member.memberCode, firstName: member.firstName, lastName: member.lastName },
        membership: membership && { ...membership, frozenUntil: freeze ? label(freeze.endDate) : null },
        // UPI payments the member reported that the gym has not confirmed yet.
        dues: { balancePaise, dueSubscriptionId, pendingClaimPaise: pendingClaims[0]?.amount ?? 0 },
        visits: { thisMonth: days.filter((day) => label(day) >= monthStart).length,
          lastVisitDate: days[0] ? label(days[0]) : null, visitedToday: days[0] ? label(days[0]) === calendar.label : false,
          weekStreak: weekStreak(days, today), recent: days.slice(0, 14).map(label) },
        // Members see their sessions, never trainer commission.
        pt: packages.map((pkg) => ({ id: String(pkg._id), name: pkg.name, trainerName: trainers.get(String(pkg.trainerId)) ?? null,
          sessionsTotal: pkg.sessionsTotal, sessionsUsed: pkg.sessionsUsed, sessionsLeft: pkg.sessionsTotal - pkg.sessionsUsed,
          expiresOn: pkg.expiresOn ? label(pkg.expiresOn) : null, expired: Boolean(pkg.expiresOn && pkg.expiresOn <= today),
          balancePaise: Math.max(0, pkg.pricePaise - pkg.paidPaise) })),
      };
    },
    async receipt(auth, authorization, paymentId) {
      return receiptService.forMember(await resolveSelfMember(auth, authorization), paymentId);
    },
  };
}
module.exports = { createMemberHomeService, weekStreak };
