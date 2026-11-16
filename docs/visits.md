# Phase 2 — member visits (check-in)

Check-in only: one recorded entry per member per gym-local day, no check-out.
Stored in the new `MemberVisit` collection. The retired `/attendance` contract,
`Attendance` model and their historical records stay untouched (see
`scope-cleanup.md`); `scopeCleanup.test.js` still guards that contract.

All endpoints: authentication, active GymAccess with the `admin` role, active
gym, standard envelope and `Cache-Control: no-store`.

## `POST /api/v1/gyms/:gymId/visits`

Strict body: `{ memberId, method?: 'manual' | 'qr', override?: boolean }`.

- Member must belong to the gym (404 `MEMBER_NOT_FOUND`) and have an `active`
  profile (409 `MEMBER_NOT_ACTIVE`).
- The membership is classified on the gym-local day (same rules as the member
  overview). Without a currently active membership the request fails with
  409 `MEMBERSHIP_NOT_ACTIVE` and
  `error.details: { membershipState: 'expired' | 'upcoming' | 'none', planName, endDate }`,
  unless `override: true`. Overridden entries are stored with `override: true`
  and the state at entry.
- Idempotent per day: a repeat returns 200 with the existing visit and
  `alreadyCheckedIn: true`; a new entry returns 201. A unique index
  `{ gymId, memberId, visitDate }` resolves concurrent requests to one visit.
  The service creates the collection's indexes on first write.
- Response: `{ member, membership, balancePaise, visit, alreadyCheckedIn }`.
- Rate limit: 120 requests per minute per client.

## `GET /api/v1/gyms/:gymId/visits/today`

Today's visits (gym-local), newest first, paginated:
`{ date, timezone, total, overrides, data: [{ visit, member }], pagination }`.

## `GET /api/v1/gyms/:gymId/members/:memberId/visits`

`{ memberId, today, visitsLast30Days, lastVisitDate, daysSinceLastVisit, data, pagination }`.

## Related additions

- Member overview rows include `lastVisitDate` and `daysSinceLastVisit`, and a
  new `inactive` filter/count: active membership and no visit for 10+ days
  (or never), sorted by longest absence.
- Dashboard `visits: { periodCount, distinctMembers, today }`.

## Member QR

The app encodes `MDK1:<gymId>:<memberId>`. It is an identifier, not a secret:
check-in still requires an authenticated admin, and the app rejects cards for
other gyms before calling the API.
