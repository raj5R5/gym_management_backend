# Phase 1 — daily operations APIs

Admin-only, gym-scoped endpoints added for the redesigned owner dashboard,
member list and plan cards. All use the standard `{ success, data, meta }`
envelope, `Cache-Control: no-store`, authentication, active GymAccess with the
`admin` role and an active gym. Trainers and members receive 403.

## Gym settings — `/api/v1/gyms/:gymId/settings`

| Method | Purpose |
| --- | --- |
| GET | `{ gymId, timezone, timezoneConfigured, gstin, address }` |
| PATCH | Strict body `{ timezone?, gstin?, address? }`; `null` clears `gstin`/`address`, omitted fields are unchanged, the timezone cannot be cleared |

- `timezone`: any IANA zone accepted by `Intl.DateTimeFormat`. It drives every
  gym-local calendar rule (membership dates, expiry, dashboard "today").
  Changing it does not migrate stored membership dates.
- `gstin`: Indian GSTIN format, stored uppercase. Format check only; it is not
  verified against the GST portal.
- `address`: `{ line1, line2?, city, state?, postalCode? }`.

## Member overview — `GET /api/v1/gyms/:gymId/member-overview`

Query: `filter` (`all` | `active` | `expiring` | `dues` | `expired` | `none`,
default `all`), `search` (code, name or phone, case-insensitive), `page`, `limit`
(max 100).

Each row: `member` (id, code, names, phone, status, scoped photo fields),
`membership` (the current period, else the next upcoming one, else the latest
expired one; `null` when the member has none), `balancePaise` (sum of unpaid
balances over all non-cancelled periods) and `dueSubscriptionId` (the earliest
period with a balance, for "Collect").

`membership`: `state` (`active` | `upcoming` | `expired`), `subscriptionId`,
`planName`, `startDate`, exclusive `endDate`, `daysLeft`, `daysSinceExpiry`,
`expiringSoon` (active, ends within 7 days and not already renewed ahead) and
`renewedAhead`.

The response also returns `counts` for every filter (independent of search and
pagination), `duesTotalPaise` and the gym `calendar`. Sorting: `expiring` by
days left, `dues` by balance (highest first), `expired` by most recent expiry,
otherwise by name.

Limitations: classification runs in memory per request and is capped at 20,000
member profiles (a larger gym gets a 500 until this moves to an aggregation).

## Additions to existing responses

- Plan list items include `activeMemberCount`: distinct members whose
  non-cancelled period on the plan covers the gym-local today.
- Dashboard `members` includes `joinedInPeriod`: member profiles created within
  the selected period's gym-local boundaries.
