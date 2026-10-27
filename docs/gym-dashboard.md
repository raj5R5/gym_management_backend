> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Gym operations dashboard

`GET /api/v1/gyms/:gymId/dashboard` is a read-only operational summary. It requires an authenticated active account/session, active GymAccess, an active gym, and an explicit **admin** role in that gym. Trainers and members are denied. Bootstrap provisioning does not grant dashboard access. Responses use `Cache-Control: no-store`.

Optional query parameters: `from`, `to` (strict `YYYY-MM-DD`) and `branchId` (ObjectId). Optional `preset=last7Days` or `preset=thisMonth` cannot be combined with `from`/`to`. Unknown parameters, MongoDB operators, malformed identifiers, impossible dates, reversed ranges and ranges exceeding **366 inclusive calendar days** return standard validation errors. The latest supported day is `9999-12-30` so its exclusive next-day boundary is representable. An existing active branch in the requested gym is required when filtering; missing/foreign branches return 404 and inactive branches return 403.

## Response

The existing envelope is retained: `success`, `data`, and `meta.requestId`. Example zero-valued metrics:

```json
{
  "success": true,
  "data": {
    "period": {
      "timezone": "Asia/Kolkata",
      "from": "2026-10-07",
      "to": "2026-10-07",
      "startUtc": "2026-10-06T18:30:00.000Z",
      "endUtc": "2026-10-07T18:30:00.000Z",
      "branchId": null
    },
    "members": { "total": 0, "active": 0, "inactive": 0, "suspended": 0 },
    "trainers": { "total": 0, "active": 0, "inactive": 0, "suspended": 0 },
    "subscriptions": { "currentlyActive": 0, "expiringSoon": 0, "expired": 0 },
    "payments": { "periodSuccessfulAmountPaise": 0, "periodSuccessfulCount": 0, "outstandingAmountPaise": 0 },
    "attendance": { "periodVisits": 0, "periodUniqueMembers": 0, "currentlyCheckedIn": 0 }
  },
  "meta": { "requestId": "example-request-id" }
}
```

No identity/profile documents, names, credentials, tokens or password hashes are returned. Errors use the existing centralized error envelope; failures never return a partial dashboard.

## Calendar policy

The default is **today in Gym.settings.timezone**, independent of server timezone. Existing gyms without a configured timezone explicitly fall back to UTC; operators should configure each gym. Invalid persisted timezones fail safely. If only `from` or only `to` is provided, that date selects a single day.

Quick presets are resolved on every request in the gym timezone: `last7Days` includes today and the preceding six calendar dates; `thisMonth` includes the first through last day of the current month. No preset retains the existing default today or explicit-date behavior. Response fields and financial/current-balance semantics remain unchanged.

`to` is inclusive. Queries use `[local midnight on from, local midnight following to)`, converted independently into UTC by MongoDB `$dateFromString`. This respects offset changes, including 23/25-hour DST days and fractional-hour timezones, without treating every local day as 24 hours. Native `Intl` determines the gym-local current calendar label. Calendar labels use UTC arithmetic solely to advance labels, never to infer timezone offsets. See [MongoDB date conversion documentation](https://www.mongodb.com/docs/manual/reference/operator/aggregation/datefromstring/).

Subscriptions already store calendar **labels** at UTC midnight. This dashboard compares those stored labels with the gym-local current date expressed at UTC midnight, preserving `[startDate, endDate)` and excluding cancelled periods. It does not shift persisted subscription boundaries or alter existing subscription APIs (which currently derive their current date in UTC). Thus, around UTC midnight, this dashboard can classify a subscription differently from an existing UTC-based subscription response. This is an explicit dashboard policy, not a migration of the subscription domain. Aligning those domains' calendar policies is future work requiring separate approval.

The requested historical range affects successful revenue/payment counts and completed attendance only. Outstanding dues always represent the current unpaid balance, independently of the selected period. Profile counts and current subscription/check-in metrics always represent current state. Expiring soon means currently effective subscriptions with `today < endDate <= today + 7 calendar labels`. Future starts, expired periods and cancelled periods are excluded. Expired means non-cancelled periods with `endDate <= today`; it counts historical subscription periods, not distinct members. Plan activation/status and creation order have no influence. Multiple overlapping effective subscriptions for one member fail closed as ambiguous domain state.

## Sources and branch scope

| Metric | Source | Branch filtering |
| --- | --- | --- |
| Member totals/statuses | MemberProfile, not UserAccount | Member's current branch |
| Trainer totals/statuses | TrainerProfile, not UserAccount | Trainer's current branch; unassigned trainers only appear in gym totals |
| Subscription metrics | MemberSubscription dates/lifecycle | Related member's current branch |
| Outstanding dues | Non-cancelled MemberSubscription price snapshots minus all succeeded payments for each subscription | Related member's current branch |
| Successful payment amount/count | Payment with `status = succeeded`, period selected by `paidAt` | Related member's current branch |
| Completed visits/distinct members | Attendance with `status = completed`, period selected by `checkInAt` | Attendance's historical branch |
| Currently checked in | Distinct members with open Attendance, independent of selected period | Attendance's recorded branch |

Profile status does not implicitly change a subscription's lifecycle or erase valid historical payments/visits. Transferring a member moves their subscription/payment attribution to their **current** branch, even for historical payment periods. It does not move historical attendance. Payment branch scope does not claim to identify where money was physically collected.

Only succeeded payments count; pending/failed/cancelled payments do not. `createdAt` never controls a financial period. Positive integer paise are summed as MongoDB Decimal128, parsed to BigInt and safely converted to the existing integer response representation. Fractional/negative/invalid source amounts and unsafe totals fail closed; no floating-point money summation is performed.

Completed visits count sessions, while unique members count each member once. Open and cancelled visits are excluded from historical visits. Open members count regardless of the requested date range; the existing partial unique index enforces at most one open visit per gym/member. Invalid duplicate open state fails closed.

## Integrity, queries and limitations

Every initial metric match includes trusted authorized `gymId`. Subscription rows require a resolvable same-gym member and plan. Payments require a same-gym member and a same-gym subscription owned by that member. Attendance additionally requires a same-gym branch. Broken, missing or foreign references are excluded rather than attributed to a different entity. Branch-dependent membership/payment joins require the member's current branch to match. Exclusion can undercount corrupted historical data; operational integrity repair belongs in a separate audited process.

There are six independent metric aggregations, run in parallel, plus one constant-size gym aggregation for timezone boundaries. No per-member queries, transactions, writes, new indexes, models, collections, counters, background jobs or caches are introduced. The existing gym-prefixed profile status/list indexes, subscription gym/status/end and member-period indexes, payment gym/status/paidAt indexes and attendance gym/status/checkInAt and branch/checkInAt indexes bound source scanning. Reference lookups use indexed `_id`. Profile branch filters currently use gym-prefixed indexes; no speculative branch indexes are added. Measure representative production queries before adding indexes.

This is a set of live reads, not a transactionally consistent accounting ledger. Concurrent changes may produce briefly mixed metrics; access is rechecked at service entry, but cannot be guaranteed against revocation occurring after that check. Empty result sets return zeros. Date range limits do not cap gym-wide current-state or historical expired-period scans; large installations may need measured query optimization later. MongoDB and Node timezone databases should be kept aligned. Historically skipped entire calendar days cannot form an ordinary single-day range; invalid resolved boundaries fail closed.

## Outstanding membership dues

`payments.outstandingAmountPaise` is the sum of each resolvable, same-gym, non-cancelled subscription's `pricePaiseSnapshot` minus its succeeded payments. It includes active, expired and future periods and inactive/suspended members; expired debt remains collectible. Cancelled subscriptions are excluded because the existing payment API cannot collect against them. Cancellation does not refund or remove successful revenue. Free and fully paid subscriptions contribute zero.

This is a current receivable, not unpaid revenue within the selected calendar period. All successful payments reduce it regardless of `paidAt`, while revenue and successful payment count keep their existing selected-period semantics. Branch attribution uses the member's current branch, matching subscription and payment metrics. Changing a plan's current price does not alter a subscription's saved price.

Payments are grouped within a correlated lookup for each subscription, constrained by gym, member and subscription identities. The price is counted once per subscription, including when several installments exist. Different memberships, including renewals, each retain their own balance. Decimal128 subtraction/summation and checked integer conversion preserve exact paise. Invalid prices/payments, per-subscription overpayment and unsafe totals fail the entire response instead of displaying a misleading balance. Broken/foreign member and plan references follow the dashboard's existing exclusion policy.
