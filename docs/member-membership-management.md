# Member membership management — Milestone 23

This operational layer uses existing MemberProfile, MemberSubscription and
Payment domains. It introduces no new membership model or policies.

## Endpoints

Under `/api/v1/gyms/:gymId/members/:memberId/memberships`:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | / | Paginated subscription history and effective current membership |
| GET | /:subscriptionId | Existing subscription DTO and successful-payment summary |
| POST | /:subscriptionId/cancel | Existing cancellation behavior and subscription DTO |

All use existing envelopes, requestId and Cache-Control: no-store. Collection
pagination remains in `meta.pagination` (page, limit, total). There are no DELETE,
generic PATCH, freeze, pause, transfer, price changes or plan changes. Renewal
remains the existing separate subscription endpoint.

## Authorization and ownership

Existing active authenticated account/session, active GymAccess and active Gym
are mandatory. Admins may manage their gym's members. Trainers must resolve
exactly one active account-linked TrainerProfile in that gym and a **current
active assignment** to the requested member. Members are denied. Assignment
revocation removes subsequent access; historical assignments do not authorize.
No trainerId or other client identity/scope override is accepted.

The member must exist in the authorized gym before subscription access or
mutation. An item must match subscriptionId, memberId and gymId. Missing,
foreign or mismatched relationships return existing safe not-found/denial
responses. Cancellation includes member/gym scope in its conditional write.
Inactive member profiles remain readable/manageable as historical records;
management does not silently activate them.

## History and current membership

Collection data contains:

```json
{
  "member": { "id": "<memberId>", "memberCode": "ME01", "firstName": "Alex", "lastName": "River" },
  "currentMembership": null,
  "subscriptions": []
}
```

The existing Member Summary subscription DTO is reused for collection/current
rows, enriched with a paymentSummary. Item and cancellation responses reuse the
existing full subscription DTO. No raw documents, auth secrets or Mongo/session
internals are exposed. Immutable stored plan snapshots supply historical name,
duration and price; current plan terms/status never reconstruct those values.
As in existing reads, missing/foreign/corrupt plan/predecessor references fail
safely rather than exposing unrelated data.

Current membership selection reuses Member Summary's validated effective-period
logic: UTC calendar today, `startDate <= today < endDate`, non-cancelled periods.
Future starts and expired/cancelled periods are excluded. No effective period
means null; exactly one means that record; multiple effective periods or
inconsistent lifecycle/reference state fail closed. No newest-created heuristic
or plan-status heuristic is used.

History query parameters: status, from, to, page and limit. Status is the existing
active/expired/cancelled convention: active includes non-cancelled periods whose
end date has not passed, including future starts; `isCurrentlyActive` distinguishes
effective periods. from/to are inclusive strict YYYY-MM-DD filters on startDate;
from must not exceed to. Unknown fields/operators/duplicate query values and
invalid IDs/dates/status/pagination are rejected. Item/cancel query parameters
are empty by contract. Page defaults to 1 (max 10000), limit to 20 (max 100).
Ordering is startDate descending then _id descending.

Current membership is evaluated across **all** member subscriptions, independent
of history status/date filters and pagination. An empty page does not erase the
current period; filters cannot conceal ambiguous effective periods. No GET
updates lifecycle/status or expires subscriptions in storage.

## Payment summaries

Every returned history/current row includes:

```json
{ "paymentSummary": { "totalSuccessfulPaidPaise": 50000, "remainingBalancePaise": 100000 } }
```

An item response contains `subscription` and `paymentSummary` with the same
fields. Only succeeded Payment records count. Pending/failed/cancelled records
are excluded. Prices come from pricePaiseSnapshot, not the current plan.
Amounts are summed in MongoDB Decimal128 and safely converted using the shared
existing exact-total helper; balance subtraction uses BigInt and outputs integer
INR paise. Invalid/fractional/negative amounts, unsafe sums, overpaid historical
state or wrong-member payment references fail closed.

The Payment service owns the batch accounting operation. It resolves bounded
subscription IDs against the same gym/member, verifies snapshots and performs
one payment aggregation for at most 100 history rows plus the current record.
Zero successful payments means zero paid and the full snapshot price remaining.
No per-subscription database loop or persisted balance is introduced. Separate
existing paginated Payment APIs remain the history source; no duplicate payment
history list is embedded here.

## Cancellation

POST accepts the existing empty-body or optional cancellationReason contract:

```json
{ "cancellationReason": "Requested by member" }
```

The subscription service performs its existing conditional one-way cancellation
and idempotent read-back. First cancellation sets cancellation timestamp/reason;
retries preserve those original values. The record remains in history and no
longer qualifies as current. Snapshot price/duration/name, original start/end
and predecessor linkage remain intact. Cancelling an older predecessor does not
rewrite or cancel its successor.

**Cancellation does not refund, delete or modify payments.** Successful payments
remain historical and still appear in summaries; no payment reversal or new
refund policy is inferred. Renewal rules are unchanged. The standalone
subscription cancellation endpoint remains admin-only; only this member-scoped
management workflow adds assigned-trainer cancellation.

## Performance and limitations

History uses one member-scoped subscription aggregation with independent current,
page, count and integrity facets. Payment totals use one bounded snapshot query
and one grouped aggregation. Existing gym/member/startDate and payment
subscription indexes are reused. No dependency, schema, index, collection,
counter, cache, transaction for reads or background job is added.

Independent reads are an operational view, not a transactional accounting
snapshot. Offset pagination can shift between requests. Access/assignment checks
observe state at lookup time and do not lock revocations for the entire request.
A payment can change between reads; cancellation remains the existing atomic
conditional update. Corrupt data produces safe errors rather than partial
responses. History filters have no new maximum date-range policy, but page size
is bounded. Freeze/pause/transfer and refunds are not implemented.

Integration tests use isolated owned MongoDB processes; real .env or development
and production data are never used.
