# Member Subscriptions — Milestones 13 and 15

MemberSubscription records a member's membership period and its historical
commercial terms. MembershipPlan is a reusable template, not the authoritative
source for an existing subscription's name, duration or price.

## Schema and snapshots

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference, derived from authorized URL scope |
| memberId | Required immutable MemberProfile reference in that gym |
| membershipPlanId | Required immutable MembershipPlan reference in that gym |
| previousSubscriptionId | Optional immutable immediate predecessor in the same gym and for the same member; absent in older records |
| isCurrentlyActive | Response-only boolean: non-cancelled and startDate <= current UTC date < endDate |
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

Ordinary creation accepts starts today or in the past. Renewal also supports future
starts, after the member has no unexpired non-cancelled membership. Dates must be real
calendar dates between year 0001 and 9999. The derived end must fit that range.
No additional status is introduced: active means non-cancelled and unexpired,
including a future renewal. `isCurrentlyActive` is true only within the actual
period. Clients must not infer current membership eligibility from status alone.
The active list filter includes future renewals, consistently with their DTO status.

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
| POST | /api/v1/gyms/:gymId/subscriptions/:subscriptionId/renew | Renew | Denied | Denied |
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
database failures produce sanitized 500 responses. Unknown lifecycle states fail
safely; future periods report isCurrentlyActive=false.

Transactions protect overlap against all application creation paths, across API
processes. Raw writes bypass the service and are not supported provisioning.
Authorization/assignment/reference checks outside creation observe lookup-time
state without locking administrative changes across the entire HTTP request.
Concurrent cancellation can conservatively cause an overlap rejection requiring
a retry. Joined offset pagination can be expensive at scale and is not a durable
snapshot across separate page requests.

Future work includes general scheduling, member self-read, refunds and billing
workflows. Subscription creation or renewal is not payment verification.
Test infrastructure now optionally starts an owned single-node replica set;
existing suites retain standalone mode. No real .env or external database is used.

## Renewal contract and history

`POST /api/v1/gyms/:gymId/subscriptions/:subscriptionId/renew` returns 201 using
existing success/error envelopes. Admin only; trainer/member denied. Accepts an
empty object, no body, or these optional fields:

```json
{
  "startDate": "2026-11-06",
  "notes": "Renewed monthly membership"
}
```

The authenticated, authorized URL gym selects scope. The predecessor URL ID
selects the member and plan; clients cannot replace those IDs, predecessor ID,
snapshots, endDate, status, roles or timestamps. Both IDs undergo strict ObjectId
validation; dates/notes are strict Zod inputs, and notes are trimmed 1–2000 chars.

Renewal creates a **new** MemberSubscription, never extends or replaces the old
one. It requires an active member, an existing active plan in the same gym and
a non-cancelled predecessor. It uses the **current** original plan's name,
duration and price: a plan repriced from 150000 to 180000 paise produces a new
180000-paise subscription while the original remains 150000. No fallback plan
is selected. Inactive plans produce 403; missing plans/members produce 404.

Default startDate is the later of the predecessor's exclusive endDate and today's
UTC calendar date. Renewal at the end boundary remains adjacent; long-expired memberships restart
today instead of silently creating another expired period. This preserves the
existing UTC subscription calendar (independent of gym-local dashboard/payment
periods). Custom starts must be at or after the predecessor's end date; explicit
historical starts are still supported and can intentionally yield an expired period.
Every non-cancelled period is checked, including future renewals and expired
history. Adjacent ranges are valid; overlap produces 409 SUBSCRIPTION_OVERLAP.
Early renewal is rejected until no unexpired non-cancelled membership remains. Old records expire naturally in responses;
renewal never cancels or modifies their business fields, snapshots or timestamps.

One direct successor per predecessor is enforced inside the transaction, even
if that successor is later cancelled. Repeating renewal returns 409
SUBSCRIPTION_ALREADY_RENEWED. Renew the latest non-cancelled subscription to
continue A → B → C. Cancellation releases its date interval for ordinary creation
but does not erase the chain; a cancelled subscription cannot itself be renewed
(409 SUBSCRIPTION_CANCELLED). Replacement of a cancelled future successor is a
separate future workflow, not silently added here.

Within one snapshot/majority transaction, renewal reads the gym-scoped predecessor,
increments the member version to serialize with all other subscription creates,
and increments the predecessor version to conflict with cancellation and existing
payment writes. MongoDB retries write conflicts with a new snapshot: a winning
cancellation denies renewal; a winning renewal precedes a later cancellation.
These internal __v coordination changes are the **only** changes to old records;
business fields and updatedAt remain untouched. Failures roll back counters and
insertion. Transactions are mandatory; standalone storage fails closed with 503.

The successor's immutable previousSubscriptionId is derived from the predecessor,
never accepted from a client. Creation of a new ID pointing backward and increasing
period boundaries prevents cycles through supported APIs. Read joins also require
a same-gym, same-member predecessor ending at or before the successor starts.
DTOs expose only the immediate predecessor ID (null for root/older records),
without recursive history or nested records. Existing bounded list filters remain;
no additional history endpoint or filter is introduced. A nonunique gymId +
previousSubscriptionId index supports successor checks; existing range indexes
remain. Startup adds the index through existing createIndexes without data migration.

Renewal creates **no Payment**, changes no old payments, and adds no payment fields
or collection. Existing payment recording remains an independent operation using
the selected subscription's own immutable price snapshot.

Authorization is rechecked against persisted access and gym status before service
execution. Snapshot reference checks observe transaction-time state; concurrent
administrative plan/access changes are not locked for the full request. Raw database
writes bypass service invariants and remain unsupported. No recursive chain repair,
renew-with-different-plan, automatic collection, refunds, deletion or cron job is added.


## Read-only renewal preview

`GET /api/v1/gyms/:gymId/subscriptions/:subscriptionId/renewal-preview` is admin-only,
uses the same scope, eligibility, current-plan lookup, overlap check and period
calculation as renewal, and returns `Cache-Control: no-store`. It uses an isolated
snapshot transaction without writing members, subscriptions or payments.

The existing success envelope contains:

```json
{
  "gymId": "<gym ID>",
  "subscriptionId": "<predecessor ID>",
  "member": {"id": "<member ID>", "firstName": "Ada", "lastName": "Lovelace", "memberCode": "M001"},
  "planId": "<current original plan ID>",
  "previousEndDate": "2026-10-01",
  "calendarTimezone": "UTC",
  "terms": {
    "planName": "Monthly",
    "durationDays": 30,
    "pricePaise": 150000,
    "startDate": "2026-10-12",
    "endDate": "2026-11-11"
  },
  "initialPaymentPaise": 0,
  "outstandingBalancePaise": 150000
}
```

Dates are `YYYY-MM-DD` with exclusive end dates. `outstandingBalancePaise` is the
new renewal's balance, not a rolled-up balance including old dues. Free plans have
zero price and balance. Renewal records no initial payment.

A client can send `{ "expectedTerms": <exact preview terms> }` to the existing
renew POST. This strict, optional guard compares current server terms inside the
renewal transaction; it cannot set snapshots or override computed end dates.
Price, name, duration or date changes return `409 RENEWAL_PREVIEW_CHANGED`, with
no new subscription and rolled-back version locks. The owner must obtain and
review a new preview before confirming again. A UTC day boundary can also change
the default dates and trigger this guard. Existing callers without expectedTerms
remain supported using the corrected default start rule.

Preview is not a reservation. Cancellation, overlap, revoked access and an existing
successor remain authoritative guards at confirmation. Concurrent administrative
changes are not globally locked: the snapshot used by the renewal determines its
terms, and those terms must match the owner's displayed preview. Duplicate renewals
are still prevented by the existing member/predecessor transaction locks and
successor check; no second payment or idempotency workflow is introduced.


## Atomic renewal with an optional initial installment

The owner wizard uses the existing preview and renewal routes. The legacy empty-body
renewal remains supported for existing clients; the wizard always uses the atomic form.

`GET /api/v1/gyms/:gymId/subscriptions/:subscriptionId/renewal-preview?planId=<active-plan-id>`
previews the selected same-gym active plan. Optional `startDate=YYYY-MM-DD` is also
validated by the same calendar/overlap rules; the current Flutter wizard uses the
default dates. With no planId the preview still uses the original plan. Existing
UTC/exclusive-end semantics are unchanged. Changing the selection requires a new
preview; confirmation rechecks terms inside the transaction.

`POST /api/v1/gyms/:gymId/subscriptions/:subscriptionId/renew` accepts the new strict
body below, requiring `Idempotency-Key` (8–128 ASCII letters, numbers, `_` or `-`):

```json
{
  "planId": "<active-plan-id>",
  "expectedTerms": {
    "planName": "Monthly",
    "durationDays": 30,
    "pricePaise": 150000,
    "startDate": "2026-10-13",
    "endDate": "2026-11-12"
  },
  "payment": {
    "amountPaise": 50000,
    "method": "cash",
    "paidAt": "2026-10-13T10:00:00.123Z"
  }
}
```

Omit payment for Pay later or a free plan. A zero initial payment object also
creates no Payment. Positive amounts must not exceed the selected plan's current
price. Methods are cash, upi, bank_transfer, card and other; positive UPI/bank/card
payments require `reference`. Existing reference uniqueness, timestamp and integer
paise validation apply through the existing payment service.

The 201 envelope contains `data: { subscription, payment, billing }`, with the
existing full subscription/payment DTOs (`payment: null` if none recorded) and
`billing: { planPricePaise, amountReceivedPaise, outstandingBalancePaise }`. The
remaining balance is only for the new membership. Old price snapshots, dates and
payments are preserved, and previous dues remain separately identifiable in history.

The existing subscription member/predecessor locks, overlap/successor checks and
payment service run in ONE snapshot/majority MongoDB transaction, together with an
immutable RenewalOperation receipt. A payment or receipt failure rolls everything
back. Transactions require replica-set storage; no sequential/nontransactional
fallback is provided. Key and normalized request digests are scoped by gym and
actor; the predecessor is part of the request digest. No raw idempotency key or
request is persisted server-side. The unique `renewal_actor_gym_key_unique` index
is created during normal server startup without deleting data.

After current admin/gym authorization, a matching committed request returns its
original receipt before recalculating dates or enforcing successor eligibility.
Replay thus survives restart, later plan repricing, midnight and subsequent
cancellation. Different payloads/predecessors under the same key return
409 IDEMPOTENCY_KEY_CONFLICT. Different keys still cannot create two successors.
Clients must keep one frozen request/key after an ambiguous outcome; a conflict
requires investigation, not automatic replacement. Definitive rejection of the
current attempt cannot establish that an earlier ambiguous attempt did not commit.

Flutter reuses the existing checked native secure-storage adapter and operation
queues. Renewal records use a distinct logical slot under the already-supported
payment prefix: `gym.payment.v1.<env>.<encoded-api-url>.<encoded-user>.<gym>.<member>.<predecessor>.renewal.pending`.
Existing installment `.pending` slots and onboarding records are never migrated,
rewritten or cleared. A prepared record and each dispatch marker are persisted
before POST; confirmations are durably verified before success is displayed.
Confirmed receipts remain until the owner selects Done. A timeout/failed outcome
write can only recover through exact replay. Replacement is allowed only after
all stored attempts have exact recognized non-commit evidence, with revision and
identity checks inside the storage queue. Cross-process/device locking is not
claimed; server transactions and unique indexes protect concurrent clients.

Deploy the backend extension and restart it to create the new index before using
the wizard. Automated tests use isolated test databases and injected storage;
real Android/iOS restart/Keychain validation remains a device integration check.

## One unexpired membership (Task 9)

Every create/purchase/onboarding/renewal path rejects a member with any
non-cancelled subscription whose exclusive end date is after today's UTC
calendar boundary (`409 ACTIVE_MEMBERSHIP_EXISTS`). Future scheduled periods
also qualify as unexpired. End date equal to today is eligible; balances do
not affect eligibility. A cancelled predecessor still cannot be renewed, but
cancellation allows a new purchase under the existing policy. Existing overlap
and direct-successor checks remain in force.

Creation paths share a real MemberProfile version write within the transaction
before checking subscriptions. MongoDB write conflicts retry with the committed
winner visible, including between standalone creation and atomic renewal/payment.
Confirmed idempotent renewal replay returns the saved result before these new
creation checks; payment collection is unchanged. No existing records are changed.
