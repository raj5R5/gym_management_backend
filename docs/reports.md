# Phase 7 — owner reports

`GET /api/v1/gyms/:gymId/reports/:kind` (admin). Query: `preset`
(`thisMonth` default, `lastMonth`, `last3Months`, `last12Months`, `thisYear`) or
`from` and `to` (gym-local days, at most 366 days, never past today), and
`scope` (`branch` default, or `all`). Response:
`{ kind, scope, period: { from, to, days, timezone }, branches: [{ gymId, name }], report }`.

With `scope=all` the report covers every active gym where the caller has an
active admin grant; access is rechecked per branch. Each branch is computed in
its own timezone over the same calendar days, its figures are added, then
rates, averages and profit are derived from the totals.

| `kind` | Report |
| --- | --- |
| `profit-loss` | Per month: membership and PT income, expenses, trainer commission, profit; expenses by category; totals and margin |
| `collections` | Membership + PT payments by method, by plan (PT as "Personal training"), by day; total, count, average |
| `members` | New members, plans started (first-time vs renewal), memberships that ended in the period and how many renewed within 30 days, renewal rate, active members at each month end, starts per plan |
| `attendance` | Visits, unique members, per day, per member; by weekday and hour (gym timezone); daily trend; active members with no visit for 14+ days (top 20) |
| `dues` | As of today (period ignored): membership dues by age (0–30, 31–60, 61–90, 90+ days since the unpaid membership started), PT dues, top 20 members owing |
| `leads` | Enquiries created in the period: trial, joined, lost, open, conversion, by source, top lost reasons |
| `trainers` | Per trainer: PT sessions, PT collected, commission, active PT clients, assigned members |
| `plans` | Per plan: sold in the period (count, plan value), members active today |

Errors: 400 `VALIDATION_ERROR` (unknown kind, one-sided or reversed range),
400 `REPORT_RANGE_TOO_LONG`, 422 `REPORT_TOO_LARGE` (over 50,000 rows in one
branch), 403 for non-admins or branches without access. Money is integer paise.
