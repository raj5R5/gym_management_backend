> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Payments — Milestone 14

Payment is an append-oriented financial record associated with a member's
subscription. MembershipPlan remains a template; MemberSubscription owns the
historical commercial terms; Payment records money manually collected.
Recording does not verify money through a gateway, create a subscription or
change membership validity. No payment state is added to MemberSubscription.

## Schema, statuses and methods

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference derived from authorized URL scope |
| memberId | Required immutable MemberProfile reference in that gym |
| subscriptionId | Required immutable MemberSubscription reference for that member/gym |
| amountPaise | Required immutable positive INR paise integer, maximum 1,000,000,000 |
| status | Required immutable pending/succeeded/failed/cancelled; API creation always succeeded |
| paymentMethod | Required immutable cash/upi/bank_transfer/card/other |
| paidAt | Required immutable actual payment timestamp |
| transactionReference | Optional immutable external reference |
| notes | Optional immutable trimmed text, 1–2000 characters |
| recordedByUserId | Optional model field; always derived from authenticated account on API creation |
| createdAt / updatedAt | Server-managed timestamps |

V1 has one public lifecycle: manual recording creates a succeeded payment and
retains it permanently. No status-transition endpoint, generic PATCH, DELETE,
correction, cancellation, reversal or refund workflow exists. The other statuses
are reserved for future integration and do not represent collected money.
Future gateway transitions must preserve financial identity and enforce the same
serialization/overpayment rules; direct writes are not a gateway interface.

All payment business fields are immutable, including method, timestamp, reference
and notes. Erroneous recordings require a future audited correction workflow;
do not edit historical amounts or use subscription cancellation as a refund.

## Money, relationships and amount policy

Every API amount is integer INR paise: ₹1500 = `150000`. Positive amounts only;
free subscriptions cannot receive a positive payment under this policy. Bounds
match existing plan/subscription money conventions. No decimal money, currency
conversion or floating-point financial calculation is performed. Stored values
are exact bounded safe integers; total/remaining comparisons use BigInt arithmetic.

Multiple partial payments are allowed. Only succeeded records for this gym and
subscription count toward collected totals. Pending, failed and cancelled records
do not count. A new amount cannot exceed `pricePaiseSnapshot - collected`.
The original snapshot remains authoritative after plan price/duration changes.

Creation verifies subscription gym, subscription member and member gym. Foreign
subscriptions return generic 404; a same-gym subscription/member mismatch returns
400. Missing members are rejected. Cancelled subscriptions cannot receive new
payments (409). Expired subscriptions and inactive/suspended members may have
outstanding amounts collected; their lifecycle is unchanged. Existing payments
remain readable after subscription cancellation. Branches are not copied into
payments, and no branch movement/ownership rule is invented.

## Concurrency and indexes

**Creation requires transaction-capable MongoDB (replica set or sharded deployment).**
Standalone MongoDB fails closed with 503 `PAYMENT_STORAGE_UNAVAILABLE`.

A snapshot transaction increments the subscription's existing `__v` version field
with timestamps disabled, then verifies relationships, reads succeeded amounts
and inserts the payment. This real write serializes creations per subscription
across API instances; write conflicts retry with fresh totals. It also conflicts
with subscription cancellation: cancellation committed before the serialized
read blocks recording. A payment committed before cancellation remains history.
The version field is coordination metadata, not payment state; subscription
schema, snapshots, status and updatedAt remain unchanged by payment recording.
Failed writes, duplicate references and business denials roll back the transaction.

Indexes support gym/member/paidAt history, gym/subscription/status totals,
gym/status/paidAt lists and gym/paidAt history. Successful external references
have partial unique `(gymId, paymentMethod, transactionReference)` indexing.
Missing references are excluded, so multiple cash payments without references
are valid. References are not globally unique. Startup creates declared indexes
additively and retains existing identity verification and unrelated indexes.

## References and paidAt

UPI, bank_transfer and card require a reference in the service layer. Cash and
other allow omission. References are trimmed, 3–120 characters, beginning with
an ASCII letter/digit; remaining characters may include ASCII letters/digits,
spaces, dot, underscore, colon, slash or hyphen. Controls/HTML-like strings are
rejected. References are case-sensitive external identifiers, preserved after
recording; the server never generates them from internal database IDs. References
matching the involved gym/member/subscription/recorder IDs are rejected. Different
methods/gyms may reuse the same reference; an exact duplicate successful reference
returns 409 `DUPLICATE_PAYMENT_REFERENCE` rather than silently inserting again.
Reference matching does not provide cash request idempotency without a reference.

paidAt is when money actually changed hands, not when staff entered the record.
It must be a real ISO timestamp with UTC or an explicit offset, between
1970-01-01T00:00:00Z and now. Future timestamps and local dates without a timezone
are rejected. Offsets normalize to the same UTC instant. Backdated receipts may
pre-date the membership period; payment timing does not establish validity.

## API and authorization

| Method | Endpoint | admin | trainer | member |
| --- | --- | --- | --- | --- |
| POST | /api/v1/gyms/:gymId/payments | Create | Denied | Denied |
| GET | /api/v1/gyms/:gymId/payments | Gym history | Actively assigned members only | Denied |
| GET | /api/v1/gyms/:gymId/payments/:paymentId | Read | Actively assigned member only | Denied |

Example create body:

```json
{
  "memberId": "<member ObjectId>",
  "subscriptionId": "<subscription ObjectId>",
  "amountPaise": 50000,
  "paymentMethod": "upi",
  "paidAt": "2026-10-07T10:30:00.000Z",
  "transactionReference": "TXN123456",
  "notes": "Partial membership payment"
}
```

Existing authentication, active GymAccess, active Gym and role guards apply.
Services recheck persisted scope and role. Recorder identity comes solely from
auth.user. Strict validation rejects client status, gymId, recordedByUserId,
roles, permissions, timestamps and arbitrary fields/operators.

Trainer reads resolve exactly one active TrainerProfile linked to the account
in the requested gym, then require an active TrainerMemberAssignment for the
payment's member. Missing/ambiguous links deny access. Filters cannot replace
trainer scope. Resource reads join member and subscription with the same gym
and verify the subscription/member match; inconsistent raw records are excluded.
Individual ownership guards run before controllers, and services repeat checks.
Routes remain authenticated even on the optional bootstrap listener.

## History and errors

Only page, limit, memberId, subscriptionId, status, paymentMethod, paidFrom and
paidTo are accepted. Page defaults to 1 (maximum 10000); limit defaults to 20
(maximum 100). paidFrom/paidTo use the same timestamp validation and inclusive
bounds, with paidFrom <= paidTo. IDs/statuses/methods are strict; arbitrary MongoDB
filters and duplicate arrays are rejected. Lists sort paidAt descending then _id
descending. Joins and authorization apply before pagination/counting; metadata
contains requestId and pagination page/limit/total.

Responses use existing envelopes and no-store headers, without credentials or
account internals. Validation/mismatch is 400; unauthenticated 401; access denial
403; missing/foreign payment 404 `PAYMENT_NOT_FOUND`; overpayment 409
`PAYMENT_OVERPAYMENT`. Unexpected failures return sanitized 500 errors. Request
bodies, financial references and notes are not added to logs.

## Limitations and deferred work

Manual records rely on authorized staff confirming collection. No gateway,
webhooks, refunds, reversals, discounts, GST/taxes, invoices or member self-read
were implemented. Do not store card numbers, CVV, bank credentials or tokens in
reference/notes fields. A future gateway needs approved idempotency, reconciliation
and transition contracts, rather than bypassing the creation invariant.

Totals currently read projected succeeded records and sum exact integers; very
large histories may need measured optimization. Joined offset pagination can
be costly and separate pages are not a persistent snapshot. Authorization and
trainer assignment checks observe lookup-time state across the HTTP request.
Raw database writes bypass application invariants and are unsupported; detected
invalid monetary data or mismatched collected records fail closed.

Tests use owned temporary MongoDB replica sets, plus an isolated standalone
failure test. No real .env or development/production database is used.

## Dashboard drill-down and idempotent collection

GET keeps its existing route and timestamp filters. Optional `from`/`to` calendar dates use the dashboard's inclusive gym-local date policy (maximum 366 days) and cannot be combined with `paidFrom`/`paidTo`. The response adds `meta.period` and an unpaginated `meta.summary` with `successfulAmountPaise` and `successfulPaymentCount`. `includeMember=true` adds a scoped member identity/contact DTO to each row; it never bypasses relationship/trainer authorization. Optional `branchId` uses authorized current-member branch attribution. Existing queries/DTOs remain unchanged when these options are absent.

POST accepts an optional `Idempotency-Key` (8–128 letters, numbers, `_` or `-`). New Flutter installment collection always supplies one. The payment's key/request digests are saved inside the same transaction as its immutable receipt, with a unique actor/gym/key index. Repeating the same normalized payload/key returns the original payment, even after its balance becomes zero or its membership is cancelled. A changed payload returns `409 IDEMPOTENCY_KEY_CONFLICT`; never use a new key to bypass an ambiguous outcome. Independent collections need distinct keys. Existing purchase/onboarding transactions and requests without this header retain their established behavior. Indexes must be created by normal server startup before accepting collection traffic. No legacy record migration is needed.
