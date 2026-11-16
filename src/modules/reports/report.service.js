const { Types } = require('mongoose');
const { gymCalendar, dashboardPeriod } = require('../gymDashboard/dashboard.period');
const { reports, mergeReports } = require('./report.builders');
const { kindNames, reportQuery } = require('./report.validation');

const DAY = 86_400_000;
const MAX_DAYS = 366;
function fail(code) { const error = new Error('Report unavailable.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const label = (date) => date.toISOString().slice(0, 10);
const utc = (year, month, dayOfMonth) => new Date(Date.UTC(year, month, dayOfMonth));

/** Calendar labels for a preset, relative to the gym-local `today` label. */
function presetRange(preset, today) {
  const [year, month] = today.split('-').map(Number);
  switch (preset) {
    case 'lastMonth': return { from: label(utc(year, month - 2, 1)), to: label(utc(year, month - 1, 0)) };
    case 'last3Months': return { from: label(utc(year, month - 3, 1)), to: today };
    case 'last12Months': return { from: label(utc(year, month - 12, 1)), to: today };
    case 'thisYear': return { from: `${year}-01-01`, to: today };
    default: return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/**
 * Owner reports for one branch, or summed over every branch the owner runs.
 * Each branch is computed in its own timezone over the same calendar days.
 */
function createReportService({ models, authorizationService, clock = () => new Date() }) {
  const { Gym, GymAccess } = models;
  return {
    async get(auth, authorization, kindName, query) {
      authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
      const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
      authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
      const kind = kindNames[kindName]; if (!kind) fail('VALIDATION_ERROR');
      const input = parse(reportQuery, query);
      const selected = new Types.ObjectId(current.gymId);
      const now = clock();
      const calendar = await gymCalendar(Gym, selected, now);
      const range = input.from ? { from: input.from, to: input.to } : presetRange(input.preset ?? 'thisMonth', calendar.label);
      // Reports never look past today.
      if (range.to > calendar.label) range.to = calendar.label;
      if (range.from > range.to) fail('VALIDATION_ERROR');
      const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY) + 1;
      if (days > MAX_DAYS) fail('REPORT_RANGE_TOO_LONG');

      let gyms = [selected];
      if (input.scope === 'all') {
        const grants = await GymAccess.find({ userId: auth.user._id, role: 'admin', status: 'active' }).select('gymId').lean();
        gyms = grants.map((grant) => grant.gymId);
      }
      const records = await Gym.find({ _id: { $in: gyms }, status: 'active' }).select('name settings.timezone createdAt')
        .sort({ createdAt: 1, _id: 1 }).lean();
      const parts = await Promise.all(records.map(async (gym) => {
        // Recheck each branch with persisted access, as the Branches summary does.
        if (input.scope === 'all') await authorizationService.requireGymAccess(auth, String(gym._id));
        const timezone = gym.settings?.timezone ?? 'UTC';
        const period = await dashboardPeriod(Gym, gym._id, timezone, range, now);
        return reports[kind].build({ gymId: gym._id, models, branch: gym.name,
          period: { start: period.start, end: period.end, from: range.from, to: range.to, timezone, today: period.today } });
      }));
      if (!parts.length) fail('FORBIDDEN');
      return { kind: kindName, scope: input.scope, period: { ...range, days, timezone: calendar.timezone },
        branches: records.map((gym) => ({ gymId: String(gym._id), name: gym.name })),
        report: reports[kind].finalize(mergeReports(parts), { days }) };
    },
  };
}
module.exports = { createReportService, presetRange };
