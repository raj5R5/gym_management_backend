/**
 * Report builders. Each `build` returns additive raw figures for one gym, so
 * branches can be merged by `mergeReports`; `finalize` then derives rates,
 * averages and profit from the merged totals.
 *
 * Calendar rules match the rest of the API: membership, visit and expense dates
 * are gym-local days stored as UTC-midnight labels; payment instants are grouped
 * by the gym's timezone.
 */
const DAY = 86_400_000;
// In-memory work is bounded per branch, like the member overview.
const MAX_ROWS = 50_000;
const TOP = 20;
const STOPPED_COMING_DAYS = 14;
const RENEWAL_GRACE_DAYS = 30;

const label = (date) => date.toISOString().slice(0, 10);
const day = (text) => new Date(`${text}T00:00:00.000Z`);
const ratio = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
function tooLarge(rows) {
  if (rows.length > MAX_ROWS) { const error = new Error('Report too large.'); error.code = 'REPORT_TOO_LARGE'; throw error; }
  return rows;
}
const person = (member, branch) => ({ id: String(member._id), name: `${member.firstName} ${member.lastName}`,
  memberCode: member.memberCode, phone: member.phone ?? null, branch });

/** Month keys ('YYYY-MM') covering [from, to]. */
function monthKeys(from, to) {
  const keys = [];
  let cursor = new Date(`${from.slice(0, 7)}-01T00:00:00.000Z`);
  while (label(cursor).slice(0, 7) <= to.slice(0, 7)) {
    keys.push(label(cursor).slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}
const keyed = (keys, make) => keys.map((key) => ({ key, ...make() }));
function addTo(rows, key, values) {
  let row = rows.find((item) => item.key === key);
  if (!row) { row = { key, ...Object.fromEntries(Object.keys(values).map((name) => [name, 0])) }; rows.push(row); }
  for (const [name, value] of Object.entries(values)) row[name] += value;
}

const reports = {
  profitLoss: {
    async build({ gymId, models: m, period }) {
      const tz = period.timezone;
      const paidIn = { $gte: period.start, $lt: period.end };
      const [membership, pt, expenses] = await Promise.all([
        m.Payment.aggregate([{ $match: { gymId, status: 'succeeded', paidAt: paidIn } },
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: tz } }, amount: { $sum: '$amountPaise' } } }]),
        m.PtPayment.aggregate([{ $match: { gymId, paidAt: paidIn } },
          { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: tz } },
            amount: { $sum: '$amountPaise' }, commission: { $sum: '$commissionPaise' } } }]),
        m.Expense.aggregate([{ $match: { gymId, status: 'active', spentOn: { $gte: day(period.from), $lte: day(period.to) } } },
          { $group: { _id: { month: { $dateToString: { format: '%Y-%m', date: '$spentOn' } }, category: '$category' },
            amount: { $sum: '$amountPaise' } } }]),
      ]);
      const months = keyed(monthKeys(period.from, period.to),
        () => ({ membershipPaise: 0, ptPaise: 0, expensesPaise: 0, commissionPaise: 0 }));
      const at = (key) => months.find((row) => row.key === key);
      for (const row of membership) if (at(row._id)) at(row._id).membershipPaise += row.amount;
      for (const row of pt) if (at(row._id)) { at(row._id).ptPaise += row.amount; at(row._id).commissionPaise += row.commission; }
      const expensesByCategory = [];
      for (const row of expenses) {
        if (at(row._id.month)) at(row._id.month).expensesPaise += row.amount;
        addTo(expensesByCategory, row._id.category, { amountPaise: row.amount });
      }
      return { months, expensesByCategory };
    },
    finalize(report) {
      for (const row of report.months) {
        row.incomePaise = row.membershipPaise + row.ptPaise;
        row.profitPaise = row.incomePaise - row.expensesPaise - row.commissionPaise;
      }
      const sum = (name) => report.months.reduce((total, row) => total + row[name], 0);
      report.totals = Object.fromEntries(['membershipPaise', 'ptPaise', 'incomePaise', 'expensesPaise', 'commissionPaise',
        'profitPaise'].map((name) => [name, sum(name)]));
      report.totals.marginPercent = ratio(report.totals.profitPaise, report.totals.incomePaise);
      report.expensesByCategory.sort((a, b) => b.amountPaise - a.amountPaise);
      return report;
    },
  },

  collections: {
    async build({ gymId, models: m, period }) {
      const tz = period.timezone;
      const paidIn = { $gte: period.start, $lt: period.end };
      const [payments, pt] = await Promise.all([
        m.Payment.aggregate([{ $match: { gymId, status: 'succeeded', paidAt: paidIn } },
          { $lookup: { from: m.MemberSubscription.collection.name, localField: 'subscriptionId', foreignField: '_id',
            pipeline: [{ $project: { planNameSnapshot: 1 } }], as: 'subscription' } },
          { $project: { amountPaise: 1, paymentMethod: 1, plan: { $ifNull: [{ $first: '$subscription.planNameSnapshot' }, 'Other'] },
            day: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: tz } } } }]),
        m.PtPayment.aggregate([{ $match: { gymId, paidAt: paidIn } },
          { $project: { amountPaise: 1, paymentMethod: 1, day: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: tz } } } }]),
      ]);
      const byMethod = []; const byPlan = []; const byDay = [];
      for (const row of [...payments, ...pt.map((item) => ({ ...item, plan: 'Personal training' }))]) {
        const values = { amountPaise: row.amountPaise, count: 1 };
        addTo(byMethod, row.paymentMethod, values); addTo(byPlan, row.plan, values); addTo(byDay, row.day, values);
      }
      return { byMethod, byPlan, byDay };
    },
    finalize(report) {
      const amount = report.byMethod.reduce((total, row) => total + row.amountPaise, 0);
      const count = report.byMethod.reduce((total, row) => total + row.count, 0);
      report.totals = { amountPaise: amount, count, averagePaise: count ? Math.round(amount / count) : 0 };
      for (const list of [report.byMethod, report.byPlan]) {
        list.sort((a, b) => b.amountPaise - a.amountPaise);
        for (const row of list) row.sharePercent = ratio(row.amountPaise, amount);
      }
      report.byDay.sort((a, b) => a.key.localeCompare(b.key));
      return report;
    },
  },

  members: {
    async build({ gymId, models: m, period }) {
      const from = day(period.from); const to = day(period.to); const today = period.today;
      const [joined, subscriptions] = await Promise.all([
        m.MemberProfile.countDocuments({ gymId, createdAt: { $gte: period.start, $lt: period.end } }),
        m.MemberSubscription.find({ gymId, status: { $ne: 'cancelled' } })
          .select('memberId planNameSnapshot startDate endDate').limit(MAX_ROWS + 1).lean().then(tooLarge),
      ]);
      const byMember = new Map();
      for (const sub of subscriptions) {
        const key = String(sub.memberId);
        if (!byMember.has(key)) byMember.set(key, []);
        byMember.get(key).push(sub);
      }
      let started = 0, firstTime = 0, expired = 0, renewed = 0;
      const startedByPlan = [];
      for (const subs of byMember.values()) {
        for (const sub of subs) {
          if (sub.startDate >= from && sub.startDate <= to) {
            started += 1;
            if (!subs.some((other) => other.startDate < sub.startDate)) firstTime += 1;
            addTo(startedByPlan, sub.planNameSnapshot, { count: 1 });
          }
          // Expired in the period: its first day without cover fell in [from, to] and has passed.
          if (sub.endDate >= from && sub.endDate <= to && sub.endDate <= today) {
            expired += 1;
            const limit = sub.endDate.getTime() + RENEWAL_GRACE_DAYS * DAY;
            if (subs.some((other) => other !== sub && other.startDate > sub.startDate && other.startDate.getTime() <= limit)) renewed += 1;
          }
        }
      }
      // Members covered at each month end (or today for the current month).
      const activeAtMonthEnd = monthKeys(period.from, period.to).map((key) => {
        const [year, month] = key.split('-').map(Number);
        const monthEnd = new Date(Date.UTC(year, month, 0));
        const at = monthEnd < today ? monthEnd : today;
        let count = 0;
        for (const subs of byMember.values()) if (subs.some((sub) => sub.startDate <= at && sub.endDate > at)) count += 1;
        return { key, count };
      });
      return { joined, started, firstTime, renewals: started - firstTime, expired, renewed, startedByPlan, activeAtMonthEnd };
    },
    finalize(report) {
      report.churned = report.expired - report.renewed;
      report.renewalRatePercent = ratio(report.renewed, report.expired);
      report.startedByPlan.sort((a, b) => b.count - a.count);
      return report;
    },
  },

  attendance: {
    async build({ gymId, models: m, period, branch }) {
      const tz = period.timezone; const today = period.today;
      const [visits, hours, last, covered] = await Promise.all([
        m.MemberVisit.find({ gymId, visitDate: { $gte: day(period.from), $lte: day(period.to) } })
          .select('memberId visitDate').limit(MAX_ROWS + 1).lean().then(tooLarge),
        m.MemberVisit.aggregate([{ $match: { gymId, visitDate: { $gte: day(period.from), $lte: day(period.to) } } },
          { $group: { _id: { $hour: { date: '$checkedInAt', timezone: tz } }, count: { $sum: 1 } } }]),
        m.MemberVisit.aggregate([{ $match: { gymId } }, { $group: { _id: '$memberId', last: { $max: '$visitDate' } } }]),
        m.MemberSubscription.find({ gymId, status: { $ne: 'cancelled' }, startDate: { $lte: today }, endDate: { $gt: today } })
          .select('memberId').lean(),
      ]);
      const byWeekday = keyed(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], () => ({ count: 0 }));
      const byHour = keyed(Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')), () => ({ count: 0 }));
      const byDay = [];
      for (const visit of visits) {
        byWeekday[(visit.visitDate.getUTCDay() + 6) % 7].count += 1;
        addTo(byDay, label(visit.visitDate), { count: 1 });
      }
      for (const row of hours) if (row._id >= 0 && row._id < 24) byHour[row._id].count += row.count;
      const lastVisit = new Map(last.map((row) => [String(row._id), row.last]));
      const activeIds = [...new Set(covered.map((sub) => String(sub.memberId)))];
      const stopped = activeIds.filter((id) => {
        const seen = lastVisit.get(id);
        return !seen || (today - seen) / DAY >= STOPPED_COMING_DAYS;
      });
      const members = await m.MemberProfile.find({ gymId, _id: { $in: stopped.slice(0, 500) }, status: 'active' })
        .select('memberCode firstName lastName phone').lean();
      const stoppedComing = members.map((member) => {
        const seen = lastVisit.get(String(member._id));
        return { ...person(member, branch), lastVisitDate: seen ? label(seen) : null,
          daysAway: seen ? Math.round((today - seen) / DAY) : null };
      });
      return { visits: visits.length, uniqueMembers: new Set(visits.map((visit) => String(visit.memberId))).size,
        activeMembers: activeIds.length, stoppedComingCount: members.length, byWeekday, byHour, byDay, stoppedComing };
    },
    finalize(report, { days }) {
      report.averagePerDay = days ? Math.round((report.visits / days) * 10) / 10 : 0;
      report.visitsPerMember = report.uniqueMembers ? Math.round((report.visits / report.uniqueMembers) * 10) / 10 : 0;
      report.byDay.sort((a, b) => a.key.localeCompare(b.key));
      // Never visited first, then longest away.
      report.stoppedComing = report.stoppedComing
        .sort((a, b) => (b.daysAway ?? Infinity) - (a.daysAway ?? Infinity)).slice(0, TOP);
      return report;
    },
  },

  dues: {
    async build({ gymId, models: m, period, branch }) {
      const today = period.today;
      const [subscriptions, paid, ptPackages] = await Promise.all([
        m.MemberSubscription.find({ gymId, status: { $ne: 'cancelled' } })
          .select('memberId pricePaiseSnapshot startDate').limit(MAX_ROWS + 1).lean().then(tooLarge),
        m.Payment.aggregate([{ $match: { gymId, status: 'succeeded' } },
          { $group: { _id: '$subscriptionId', amount: { $sum: '$amountPaise' } } }]),
        m.PtPackage.find({ gymId, status: { $ne: 'cancelled' } }).select('memberId pricePaise paidPaise').lean(),
      ]);
      const paidBy = new Map(paid.map((row) => [String(row._id), row.amount]));
      const ageing = keyed(['0-30', '31-60', '61-90', '90+'], () => ({ amountPaise: 0, count: 0 }));
      const debtors = new Map();
      for (const sub of subscriptions) {
        const balance = sub.pricePaiseSnapshot - (paidBy.get(String(sub._id)) ?? 0);
        if (balance <= 0) continue;
        const age = Math.max(0, Math.round((today - sub.startDate) / DAY));
        ageing[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3].amountPaise += balance;
        ageing[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3].count += 1;
        const key = String(sub.memberId);
        const row = debtors.get(key) ?? { amountPaise: 0, oldestDays: 0 };
        row.amountPaise += balance; row.oldestDays = Math.max(row.oldestDays, age);
        debtors.set(key, row);
      }
      let ptDuesPaise = 0;
      for (const pkg of ptPackages) ptDuesPaise += Math.max(0, pkg.pricePaise - pkg.paidPaise);
      const topIds = [...debtors.entries()].sort((a, b) => b[1].amountPaise - a[1].amountPaise).slice(0, TOP);
      const members = new Map((await m.MemberProfile.find({ gymId, _id: { $in: topIds.map(([id]) => id) } })
        .select('memberCode firstName lastName phone').lean()).map((member) => [String(member._id), member]));
      const topDebtors = topIds.filter(([id]) => members.has(id))
        .map(([id, row]) => ({ ...person(members.get(id), branch), ...row }));
      return { membershipDuesPaise: ageing.reduce((total, row) => total + row.amountPaise, 0), ptDuesPaise,
        membersOwing: debtors.size, ageing, topDebtors };
    },
    finalize(report) {
      report.totalDuesPaise = report.membershipDuesPaise + report.ptDuesPaise;
      report.topDebtors = report.topDebtors.sort((a, b) => b.amountPaise - a.amountPaise).slice(0, TOP);
      return report;
    },
  },

  leads: {
    async build({ gymId, models: m, period }) {
      const leads = await m.Lead.find({ gymId, createdAt: { $gte: period.start, $lt: period.end } })
        .select('source status trialStartDate lostReason').limit(MAX_ROWS + 1).lean().then(tooLarge);
      const bySource = []; const lostReasons = [];
      let trialed = 0, joined = 0, lost = 0, open = 0;
      for (const lead of leads) {
        const isJoined = lead.status === 'joined';
        addTo(bySource, lead.source, { count: 1, joined: isJoined ? 1 : 0 });
        if (lead.trialStartDate) trialed += 1;
        if (isJoined) joined += 1;
        else if (lead.status === 'lost') {
          lost += 1;
          addTo(lostReasons, (lead.lostReason ?? 'No reason').trim().toLowerCase().slice(0, 60) || 'no reason', { count: 1 });
        } else open += 1;
      }
      return { created: leads.length, trialed, joined, lost, open, bySource, lostReasons };
    },
    finalize(report) {
      report.conversionPercent = ratio(report.joined, report.created);
      report.trialConversionPercent = ratio(report.joined, report.trialed);
      for (const row of report.bySource) row.conversionPercent = ratio(row.joined, row.count);
      report.bySource.sort((a, b) => b.count - a.count);
      report.lostReasons = report.lostReasons.sort((a, b) => b.count - a.count).slice(0, 5);
      return report;
    },
  },

  trainers: {
    async build({ gymId, models: m, period, branch }) {
      const [trainers, sessions, payments, packages, assignments] = await Promise.all([
        m.TrainerProfile.find({ gymId }).select('firstName lastName trainerCode status').lean(),
        m.PtSession.aggregate([{ $match: { gymId, sessionDate: { $gte: day(period.from), $lte: day(period.to) } } },
          { $group: { _id: '$trainerId', count: { $sum: 1 } } }]),
        m.PtPayment.aggregate([{ $match: { gymId, paidAt: { $gte: period.start, $lt: period.end } } },
          { $group: { _id: '$trainerId', amount: { $sum: '$amountPaise' }, commission: { $sum: '$commissionPaise' } } }]),
        m.PtPackage.aggregate([{ $match: { gymId, status: 'active' } },
          { $group: { _id: '$trainerId', clients: { $addToSet: '$memberId' } } }]),
        m.TrainerMemberAssignment.aggregate([{ $match: { gymId, status: 'active' } },
          { $group: { _id: '$trainerId', count: { $sum: 1 } } }]),
      ]);
      const of = (rows, field = 'count') => new Map(rows.map((row) => [String(row._id), row[field]]));
      const sessionsBy = of(sessions); const amountBy = of(payments, 'amount'); const commissionBy = of(payments, 'commission');
      const clientsBy = new Map(packages.map((row) => [String(row._id), row.clients.length])); const assignedBy = of(assignments);
      const rows = trainers.map((trainer) => {
        const id = String(trainer._id);
        return { key: id, name: `${trainer.firstName} ${trainer.lastName}`, trainerCode: trainer.trainerCode, branch,
          active: trainer.status === 'active' ? 1 : 0, sessions: sessionsBy.get(id) ?? 0, ptCollectedPaise: amountBy.get(id) ?? 0,
          commissionPaise: commissionBy.get(id) ?? 0, ptClients: clientsBy.get(id) ?? 0, assignedMembers: assignedBy.get(id) ?? 0 };
      }).filter((row) => row.active || row.sessions || row.ptCollectedPaise);
      return { trainers: rows };
    },
    finalize(report) {
      report.trainers.sort((a, b) => b.ptCollectedPaise - a.ptCollectedPaise || b.sessions - a.sessions);
      const sum = (name) => report.trainers.reduce((total, row) => total + row[name], 0);
      report.totals = { sessions: sum('sessions'), ptCollectedPaise: sum('ptCollectedPaise'), commissionPaise: sum('commissionPaise'),
        ptClients: sum('ptClients') };
      return report;
    },
  },

  plans: {
    async build({ gymId, models: m, period }) {
      const today = period.today;
      const [sold, active] = await Promise.all([
        m.MemberSubscription.aggregate([{ $match: { gymId, status: { $ne: 'cancelled' },
          startDate: { $gte: day(period.from), $lte: day(period.to) } } },
        { $group: { _id: '$planNameSnapshot', count: { $sum: 1 }, revenuePaise: { $sum: '$pricePaiseSnapshot' } } }]),
        m.MemberSubscription.aggregate([{ $match: { gymId, status: { $ne: 'cancelled' }, startDate: { $lte: today },
          endDate: { $gt: today } } }, { $group: { _id: '$planNameSnapshot', members: { $addToSet: '$memberId' } } }]),
      ]);
      const plans = [];
      for (const row of sold) addTo(plans, row._id, { sold: row.count, revenuePaise: row.revenuePaise, activeMembers: 0 });
      for (const row of active) addTo(plans, row._id, { sold: 0, revenuePaise: 0, activeMembers: row.members.length });
      return { plans };
    },
    finalize(report) {
      const revenue = report.plans.reduce((total, row) => total + row.revenuePaise, 0);
      for (const row of report.plans) row.sharePercent = ratio(row.revenuePaise, revenue);
      report.plans.sort((a, b) => b.revenuePaise - a.revenuePaise || b.activeMembers - a.activeMembers);
      report.totals = { sold: report.plans.reduce((t, r) => t + r.sold, 0), revenuePaise: revenue,
        activeMembers: report.plans.reduce((t, r) => t + r.activeMembers, 0) };
      return report;
    },
  },
};

/** Adds branch reports: numbers sum, `key`ed rows merge by key, other lists concatenate. */
function mergeReports(parts) {
  const merge = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a + b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (![...a, ...b].every((row) => row && typeof row === 'object' && 'key' in row)) return [...a, ...b];
      const out = a.map((row) => ({ ...row }));
      for (const row of b) {
        const index = out.findIndex((item) => item.key === row.key);
        if (index < 0) out.push({ ...row }); else out[index] = merge(out[index], row);
      }
      return out;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])]
        .map((key) => [key, key in a && key in b ? merge(a[key], b[key]) : (a[key] ?? b[key])]));
    }
    return a;
  };
  return parts.reduce((total, part) => merge(total, part));
}

module.exports = { reports, mergeReports, monthKeys, kinds: Object.keys(reports) };
