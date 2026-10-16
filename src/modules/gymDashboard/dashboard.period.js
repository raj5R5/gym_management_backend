function failure(code) { const error = new Error('Dashboard period unavailable.'); error.code = code; throw error; }
function localDate(now, timezone) {
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { failure('INVALID_DASHBOARD_STATE'); }
  const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}
async function dashboardPeriod(Gym, gymId, timezone, query, now) {
  const today = localDate(now, timezone);
  let from = query.from ?? query.to ?? today; let to = query.to ?? query.from ?? today;
  // UTC arithmetic advances calendar labels only; MongoDB still resolves each
  // gym-local midnight independently, including offset changes and DST.
  if (query.preset === 'last7Days') {
    const first = new Date(`${today}T00:00:00.000Z`); first.setUTCDate(first.getUTCDate() - 6);
    from = first.toISOString().slice(0, 10); to = today;
  } else if (query.preset === 'thisMonth') {
    from = `${today.slice(0, 7)}-01`;
    const last = new Date(`${from}T00:00:00.000Z`); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
    to = last.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from < '0001-01-01' || to >= '9999-12-31') failure('VALIDATION_ERROR');
  const next = new Date(`${to}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  // Resolve each local midnight independently: offsets and DST can differ at either boundary.
  const [period] = await Gym.aggregate([{ $match: { _id: gymId, status: 'active' } }, { $project: {
    _id: 0, start: { $dateFromString: { dateString: from, format: '%Y-%m-%d', timezone } },
    end: { $dateFromString: { dateString: nextDate, format: '%Y-%m-%d', timezone } },
  } }]);
  if (!period) failure('FORBIDDEN');
  if (!(period.start instanceof Date) || !(period.end instanceof Date) || period.start >= period.end
    || localDate(period.start, timezone) !== from) failure('VALIDATION_ERROR');
  return { today: new Date(`${today}T00:00:00.000Z`), start: period.start, end: period.end,
    dto: { timezone, from, to, startUtc: period.start.toISOString(), endUtc: period.end.toISOString(), branchId: query.branchId?.toLowerCase() ?? null } };
}
module.exports = { dashboardPeriod };
