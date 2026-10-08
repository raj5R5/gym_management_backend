# Member membership purchase — Milestone 22

`POST /api/v1/gyms/:gymId/member-memberships` sells an existing active plan to an
existing active member, optionally recording a successful manual payment. This
is an orchestration workflow over MemberSubscription and Payment services; it
does not replace their standalone APIs or introduce a purchase collection.

## Authorization and request

Existing authentication, active account/session, active GymAccess and active gym
are required. Admins may purchase for members in that gym. Trainers must resolve
exactly one active TrainerProfile linked to their authenticated account in that
gym and have a current active TrainerMemberAssignment for the member. Missing,
inactive or ambiguous profiles fail closed. Unassigned members return the
existing MEMBER_NOT_FOUND response. Members are denied. No trainerId, gymId or
recorder identity can be supplied in the body to expand scope.

```json
{
  "memberId": "<memberId>",
  "planId": "<membershipPlanId>",
  "startDate": "2026-10-08",
  "payment": {
    "enabled": true,
    "method": "cash",
    "amountPaise": 50000,
    "paidAt": "2026-10-08T04:00:00.000Z",
    "reference": "RECEIPT-1001"
  }
}
```

memberId and planId are required strict ObjectIds. startDate is optional: omission
uses the subscription domain's existing UTC-today helper. Supplied dates reuse
its strict calendar and non-future creation validator. Stored subscription dates
remain UTC calendar labels with `[startDate, endDate)` semantics, independent of
gym-local dashboard dates. Existing standalone creation still requires an
explicit startDate; its contract is unchanged.

Omit payment or send exactly `{ "enabled": false }` for subscription only. When
enabled, method, amountPaise and paidAt are required; reference is optional under
the existing method rules. Disabled-payment fields beyond enabled are rejected.
All unknown fields, arbitrary operators, snapshot overrides, payment IDs/status,
permissions, trainer/recorder IDs and nested ownership fields are rejected.

## Subscription and payment rules

The subscription service owns same-gym member eligibility, active plan lookup,
plan validation, immutable name/duration/price snapshots, date calculation,
overlap checks and the member version write. Inactive/suspended members are
rejected without status changes. Missing/foreign members/plans use their existing
404 errors; inactive plans use the existing FORBIDDEN response. Later plan edits
do not alter subscription snapshots. Cancelled periods do not block a new period,
while overlapping non-cancelled periods produce SUBSCRIPTION_OVERLAP.

Payment reuses the existing service and validation: positive integer INR paise,
no inferred full-price amount, explicit past/current ISO paidAt, existing
reference validation/uniqueness and exact BigInt remaining-price calculations.
Partial payments are supported. Overpayment returns PAYMENT_OVERPAYMENT.

Methods match the existing enum exactly: cash, upi, bank_transfer, card and other.
UPI/bank transfer/card require references. The authenticated user is the recorder,
including for trainer purchases. Payment always targets the newly created
subscription and same member/gym. No pending payment, gateway, refund, automatic
billing or duplicated balance field is introduced.

## Transactions and concurrency

The orchestration service owns one snapshot transaction with majority write
concern. Its domain-service entry points require an active transaction from the
same MongoDB client. They reuse existing insert/payment routines instead of
creating nested sessions. Standalone endpoints retain their own transactions
and admin-only create policies.

Subscription and payment commit together or both roll back, including member
and subscription version guards. Missing payment references, overpayment,
duplicate payment references, database errors and commit failures cannot leave
partial workflow state. Subscription-only purchases also use the existing
transaction-required overlap protection. Standalone MongoDB returns the existing
503 SUBSCRIPTION_STORAGE_UNAVAILABLE; there is no non-transactional fallback.

The existing real MemberProfile.__v write serializes period creation/renewal,
including concurrent requests through the standalone subscription API. The
existing subscription version write protects payment balance/cancellation
consistency. Driver retries rerun the transaction's domain checks. Concurrent
same-period purchases leave one complete winning operation and a clean overlap
conflict for the loser, never an orphan payment/subscription.

## Response and errors

201 uses the standard envelope, request ID and Cache-Control: no-store:

```json
{
  "success": true,
  "data": {
    "subscription": { "id": "<new subscriptionId>", "memberId": "<memberId>", "pricePaiseSnapshot": 150000 },
    "payment": { "id": "<new paymentId>", "subscriptionId": "<new subscriptionId>", "amountPaise": 50000, "status": "succeeded" }
  },
  "meta": { "requestId": "<requestId>" }
}
```

The abbreviated objects above are the full existing allowlisted subscription
and payment DTOs in actual responses. Without payment, payment is null. No
unrestricted read-back or extra population is performed: both DTOs come directly
from documents created by the scoped domain services. Passwords, tokens,
sessions, transaction internals and raw Mongo fields are absent. The existing
safe centralized validation/business/duplicate-key/503/error mappings remain.

## Limits and excluded operations

No general idempotency framework is added. Repeating a successful same-period
request returns overlap conflict; a lost response must be resolved through the
existing scoped subscription/payment read APIs. The workflow does not silently
return the original result.

No MemberProfile, UserAccount, GymAccess or trainer assignment is created, and no
member/account/access status or role is changed. Internal version increments are
concurrency guards, not business status changes. Existing indexes are reused;
there are no caches, counters, jobs, new models, collections or dependencies.

Authorization/profile/assignment checks observe state at their lookup time; they
do not lock all administrative revocations for the full request. Financial and
period writes share the transaction, but no claim of request-wide serializability
for every authorization source is made. UTC subscription policy is unchanged.
Tests use isolated owned MongoDB replica sets and a standalone failure case,
never real .env/database credentials.
