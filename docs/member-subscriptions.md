# Member Subscriptions — Milestone 13

MemberSubscription records a member's membership period and its historical
commercial terms. MembershipPlan is a reusable template, not the authoritative
source for an existing subscription's name, duration or price.

## Schema and snapshots

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference, derived from authorized URL scope |
| memberId | Required immutable MemberProfile reference in that gym |
| membershipPlanId | Required immutable MembershipPlan reference in that gym |
| startDate / endDate | Required immutable UTC-midnight dates, returned as YYYY-MM-DD |
| planNameSnapshot | Required immutable plan name copied at creation |
| durationDaysSnapshot | Required immutable integer, 1–3650 days |
| pricePaiseSnapshot | Required immutable INR paise integer, 0–1,000,000,000 |
| status | Server-managed active, expired or cancelled |
| notes | Optional trimmed text, 1–2000 characters |
| cancelledAt | Server-managed cancellation timestamp |
| cancellationReason | Optional trimmed text, 1–500 characters |
| createdAt / updatedAt | Server-managed timestamps |

Creation requires an active member and active plan in the authorized, active gym.
The transaction copies the plan's name/duration/price into immutable snapshots.
₹1500 is `150000` paise. Bounds match MembershipPlan; no money conversion or
floating-point monetary calculations occur. Plan edits/deactivation never rewrite
subscriptions. Historical responses use snapshots; reference joins select only
IDs to verify tenancy, not current commercial terms or plan status.

No branch is copied into the subscription. Branch reporting can later derive
from MemberProfile. Profiles/accounts/grants are not created or moved.

## Calendar dates and lifecycle

Periods are `[startDate, endDate)`: startDate is included, endDate excluded.
endDate is startDate plus durationDaysSnapshot using UTC calendar arithmetic.
For example, a 30-day period starting 2024-02-01 ends 2024-03-02. Server timezone
and daylight-saving changes do not affect this calculation.

V1 accepts starts today or in the past; future scheduling is deferred so no
additional scheduled lifecycle status is invented. Dates must be real calendar
dates between year 0001 and 9999. The derived end date must also fit that range.

Stored status is active/expired at creation and cancelled on cancellation.
Read responses calculate effective expiration from endDate and the current UTC
date, so a stored active record cannot remain active after its exclusive end.
Status filters use the same boundary. GET does not update documents or require a
background job. Existing inactive members/plans do not invalidate history;
authorized staff can still inspect/cancel those subscriptions.

Cancellation is an explicit admin operation, including for expired periods.
It atomically sets status/cancelledAt and optional reason without touching terms.
Repeated/concurrent cancellations retain the first timestamp and reason. There
is no reactivation, generic PATCH, DELETE, refund or automatic payment behavior.

## Overlap and transaction requirement

All non-cancelled periods participate, including expired history and any existing
future records. Ranges overlap when `newStart < existingEnd` and
`existingStart < newEnd`. Adjacent periods are valid; cancelled periods release
their interval for a new record. Overlap returns 409 `SUBSCRIPTION_OVERLAP`.

**Creation requires MongoDB transactions: a replica set or transaction-capable
sharded deployment.** A standalone database fails closed with 503
`SUBSCRIPTION_STORAGE_UNAVAILABLE`; there is no unsafe fallback.

Within a snapshot transaction, creation increments the member's existing `__v`
version field to serialize concurrent creations for that member, then checks
references/overlap and inserts the subscription. This real write causes competing
transactions to conflict and retry against fresh state. A no-op update would not
provide that protection. Failed transactions roll back both version increment
and subscription creation. Profile business fields and updatedAt are unchanged;
no MemberProfile schema change or separate lock model was introduced.

Indexes support gym/member/date ranges, gym/plan lists, gym/status/end dates,
gym/start dates and gym creation-time lists. They are not fake overlap uniqueness
constraints. Startup creates indexes additively, preserving existing identity
index verification and unrelated indexes.

## API and authorization

| Method | Endpoint | admin | trainer | member |
| --- | --- | --- | --- | --- |
| POST | /api/v1/gyms/:gymId/subscriptions | Create | Denied | Denied |
| GET | /api/v1/gyms/:gymId/subscriptions | Gym list | Assigned members only | Denied |
| GET | /api/v1/gyms/:gymId/subscriptions/:subscriptionId | Read | Assigned member only | Denied |
| PATCH | /api/v1/gyms/:gymId/subscriptions/:subscriptionId/cancel | Cancel | Denied | Denied |

Create accepts only:

```json
{
  "memberId": "<member ObjectId>",
  "membershipPlanId": "<plan ObjectId>",
  "startDate": "2026-10-07",
  "notes": "Optional internal note"
}
```

Cancel accepts an optional body `{ "cancellationReason": "Requested" }`, an
empty object or no body. Protected snapshots, dates, status, IDs, roles, permissions,
timestamps and unknown fields are rejected. Responses use existing envelopes,
requestId, no-store headers and explicit DTOs with no account/credential fields.

Existing authentication, active GymAccess, active Gym and explicit role guards
remain mandatory. Services recheck persisted gym scope/role for direct callers.
Trainer reads resolve exactly one active TrainerProfile linked to the authenticated
account in that gym. Missing or ambiguous links deny access. An active assignment
with that server-derived trainer ID and the subscription's member ID is required.
Filters cannot replace this condition. Assignment deactivation removes trainer
read access immediately on subsequent requests. Guards check individual ownership
before controllers; services independently enforce it again.

Resource queries include subscription ID and gym ID. Aggregation joins validate
that member and plan also belong to that gym; inconsistent raw reference records
are excluded. Trainer assignment joins use the same gym. Unrelated/missing/foreign
subscriptions return generic 404 `SUBSCRIPTION_NOT_FOUND`.

## Listing, errors and limits

Only page, limit, status, memberId and membershipPlanId are accepted. Page defaults
to 1, maximum 10000; limit defaults to 20, maximum 100. IDs must be valid 24-digit
hexadecimal ObjectIds. MongoDB operators, arbitrary filters and duplicate arrays
are rejected. Status is effective active/expired/cancelled. Lists sort by createdAt
descending then _id descending and return meta.pagination with page/limit/total.
Joins and filters apply before pagination and counting, including trainer scope.

Validation is 400; missing authentication 401; access/role/inactive creation
reference denial 403; missing resources 404; overlapping periods 409. Unexpected
database failures produce sanitized 500 responses. Invalid raw future/unknown
lifecycle state fails safely rather than masquerading as an active subscription.

Transactions protect overlap against all application creation paths, across API
processes. Raw writes bypass the service and are not supported provisioning.
Authorization/assignment/reference checks outside creation observe lookup-time
state without locking administrative changes across the entire HTTP request.
Concurrent cancellation can conservatively cause an overlap rejection requiring
a retry. Joined offset pagination can be expensive at scale and is not a durable
snapshot across separate page requests.

Future work includes scheduling policy, member self-read, payments, refunds,
renewals and billing workflows. Subscription creation is not payment verification.
Test infrastructure now optionally starts an owned single-node replica set;
existing suites retain standalone mode. No real .env or external database is used.
