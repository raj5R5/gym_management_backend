# Attendance — Milestone 16

Attendance records one gym member visit. It is separate from MemberSubscription
and Payment, and never changes either domain, including subscription version
counters. No payment is collected or inferred by attendance.

## API contracts

All endpoints use the existing success/error envelopes with requestId and
Cache-Control: no-store. Authentication, active GymAccess and active Gym are
mandatory. Members are denied; no self-service endpoint is introduced.

| Method | Path under /api/v1/gyms/:gymId/attendance | Purpose |
| --- | --- | --- |
| POST | /check-in | Record a new open visit |
| POST | /:attendanceId/check-out | Complete an open visit |
| GET | / | Bounded history |
| GET | /:attendanceId | Individual visit |

Check-in accepts exactly:

```json
{ "memberId": "<ObjectId>", "branchId": "<ObjectId>" }
```

Check-out accepts an empty object or no body. Strict Zod schemas reject unknown
fields, including gymId, subscriptionId, recordedByUserId, timestamps and status.
There is no generic PATCH, DELETE, cancellation or reopening endpoint. Notes are
not accepted in this initial contract.

DTOs expose id, gymId, memberId, branchId, subscriptionId, recordedByUserId,
status, checkInAt, checkOutAt, durationMs, createdAt and updatedAt. checkOutAt and
durationMs are null while open. No credential or profile/contact data is included.

## Check-in and membership eligibility

The service independently rechecks persisted authorization. It loads the member
and branch within the authorized gym. The member must be active, have a branch
assignment, and match the supplied branch; the branch must be active. Inactive or
suspended members are denied. Cross-gym/missing member or branch returns 404;
inactive branch or branch mismatch returns a specific 409 conflict.

The server captures one UTC instant for checkInAt and derives its UTC calendar
midnight to evaluate membership. It selects only subscriptions in the same gym,
for that member, with `startDate <= attendanceDate < endDate` and non-cancelled
status. No client-supplied subscription is accepted. There must be exactly one
candidate with a recognized active state; overlapping candidates or inconsistent
status fail closed with 409 ATTENDANCE_MEMBERSHIP_AMBIGUOUS. No candidate produces
409 ATTENDANCE_MEMBERSHIP_REQUIRED. Future active renewals and exclusive end dates
never authorize a visit. A future renewal alongside a current period does not
create ambiguity because only the current period is considered.

The selected plan reference must belong to the same gym. Mutable plan price,
duration and status do not override an existing subscription's historical period;
a plan deactivation alone does not revoke it. A renewal predecessor reference,
when present, must also be same-gym/same-member and end before the new period.
The chosen subscription ID remains on the visit after plan edits or renewal.

## Authorization and branch history

Admins can check in/out and inspect visits in their authorized gym. Trainers
resolve exactly one active TrainerProfile linked to the authenticated account in
that gym. Missing, inactive, suspended, unlinked or ambiguous profiles deny access.
Every trainer operation intersects an active TrainerMemberAssignment for that
server-derived trainer and member. A client member/filter cannot replace it.
Assignment revocation removes trainer access on subsequent operations.

History validates member, branch and subscription references against the gym;
the subscription must also reference the attendance member. Foreign/missing or
inconsistent references are excluded and individual lookups return 404.
Historical branch identity does not follow a later member branch transfer.

Check-out needs current staff authorization and assignment scope, but does not
require today's membership or an active member/branch. Staff must be able to
close a visit after expiry, suspension, branch deactivation or transfer. Those
changes do not rewrite the visit or permit new check-in.

## Lifecycle and immutability

Normal lifecycle is `open -> completed`. Cancelled is a recognized storage state
but no cancellation operation is exposed. Check-out of completed/cancelled visits
returns 409 ATTENDANCE_NOT_OPEN. The server assigns checkOutAt, verifies it is not
before checkInAt, and performs an atomic conditional update matching status=open.
Concurrent check-outs have one winner; later attempts cannot alter its timestamp.

Gym, member, branch, subscription, recorder and check-in timestamp are immutable
schema fields. Document saves/replacements of existing visits are rejected;
model query updates permit only an explicit conditional open-to-completed change.
Completed visit identities and timestamps cannot be rewritten through these paths.
Direct raw collection writes bypass model/service protections and are unsupported.
Duration is response-only integer milliseconds `checkOutAt - checkInAt`, never a
persisted mutable field. All timestamps are server-derived UTC ISO instants.

## Open-session invariant and indexes

A partial unique index on `{ gymId: 1, memberId: 1 }` with `status=open` enforces
one open visit per member per gym. An application precheck provides a clear error,
but the index is authoritative even if two requests both see no open visit.
Duplicate-key errors map to 409 ATTENDANCE_ALREADY_OPEN. Completion releases the
open slot without deleting or modifying history. Each attendance insertion is
one atomic document write; multi-document transactions are not needed to enforce
this invariant, and no subscription/payment locks or writes are introduced.

Indexes are created additively by the existing server startup createIndexes:

- attendance_open_member_unique: gym + member, unique only for open visits
- attendance_member_list: gym + member + checkInAt + _id
- attendance_branch_list: gym + branch + checkInAt + _id
- attendance_subscription_list: gym + subscription + checkInAt + _id
- attendance_status_list: gym + status + checkInAt + _id
- attendance_gym_list: gym + checkInAt + _id

Startup does not drop unrelated indexes; index failures prevent successful startup.
The db:indexes command remains the existing identity migration command, not a
replacement for the domain startup index path. No schema migration of existing
subscriptions, plans or payments is required.

## Bounded history

Only page, limit, memberId, branchId, subscriptionId, status, checkInFrom and
checkInTo are accepted. Page defaults to 1 (max 10000); limit defaults to 20
(max 100). IDs are 24-digit hexadecimal ObjectIds. Dates are real ISO timestamps
with explicit UTC/offset, at or after 1970; from must not exceed to. Range filters
apply inclusively to checkInAt. Results sort by checkInAt descending then _id
descending; scope/reference checks apply before pagination and total counting.
Mongo operators, arrays/duplicate query values and arbitrary filters are rejected.

## Operational limits and security

Checks observe persisted state at lookup time. They do not lock administrative
changes for the entire HTTP request: simultaneous subscription cancellation,
branch/member changes or assignment revocation can finish after an eligibility
lookup. No request-wide serializability across those domains is claimed. Existing
visits retain their historical eligibility linkage. The unique open-session index
and atomic check-out remain authoritative under concurrent attendance requests.
A lost successful check-in response can be resolved through history; no idempotency
key, offline/backdated attendance, automatic checkout, refunds, cancellations,
member self-service or reporting/dashboard feature is added. Server clocks should
be synchronized; backward clock movement fails checkout safely rather than
creating a negative duration. Joined offset pagination is not a durable snapshot.

Database failures produce sanitized existing 500 envelopes and deny the operation.
Tests use owned temporary MongoDB databases, including real concurrency and index
checks; no real .env or development/production database is used.
