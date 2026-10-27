> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Member 360 summary — Milestone 17

`GET /api/v1/gyms/:gymId/members/:memberId/summary` combines existing operational
member data. It creates no collection/model, cache, stored totals or background
job, and performs no domain writes or transaction/lock acquisition.

## Response

The existing success envelope is `{ success: true, data: { ... }, meta: { requestId } }`.
Responses use Cache-Control: no-store. The data object contains:

| Section | Fields / semantics |
| --- | --- |
| member | id, memberCode, firstName, lastName, phone, status, branchId, optional dateOfBirth/gender/address/emergencyContact, createdAt/updatedAt |
| currentBranch | id, name, status, address/contact; null when absent, missing or outside this gym |
| currentTrainers | Valid active assignments with trainerId/code, names, phone, optional specializations, assignedAt |
| currentSubscription | id, membershipPlanId, snapshot name/duration/price, dates, effective status, isCurrentlyActive, immediate previousSubscriptionId; null if no current period |
| subscriptionHistory | items, total, page, limit |
| paymentSummary | totalSuccessfulAmountPaise, successfulPaymentCount, latestSuccessfulPayment |
| currentSubscriptionPaymentSummary | pricePaise, paidAmountPaise, remainingAmountPaise, paymentCount; null without current subscription |
| attendanceSummary | totalCompletedVisits, latestAttendance, currentlyCheckedIn, currentAttendance |

Latest successful payment includes id, subscriptionId, amountPaise, paymentMethod,
paidAt and optional transactionReference. Latest/current attendance includes id,
branchId, subscriptionId, UTC checkInAt/checkOutAt and status. Open checkout is null.
No duration or totals are stored; this endpoint does not return a duration field.
Missing optional fields may be omitted; empty summaries have zero totals and null
latest/current records. A missing/foreign current branch produces null member.branchId
in this response as well; it never exposes a foreign branch identifier.

## Authorization and privacy

Authentication requires an active account/session. Every operation requires active
GymAccess, an active Gym and an explicit admin/trainer role. Admins may read the
requested member within their gym. Trainers resolve exactly one active linked
TrainerProfile and must have an active TrainerMemberAssignment for that member
in that gym. Inactive/unlinked/ambiguous trainers are denied. Assignment deactivation
removes access on subsequent requests. Inactive/suspended members remain readable
by authorized staff; reading history does not grant attendance eligibility.
Members have no self-service access yet.

The URL selects a requested scope, not permission. Services re-resolve persisted
authorization for direct callers; route guards also check ownership before the
controller. Missing/foreign/unassigned members use the existing 404 MEMBER_NOT_FOUND
behavior without revealing existence in another gym. Invalid grants/roles use 403.

Member, trainer and branch DTOs explicitly allowlist fields, including nested
address/contact fields. No UserAccount join is performed by the summary service.
Account IDs, password hashes, JWTs, refresh tokens, session data, security events,
version counters and other arbitrary stored fields are not included. Phone/address
and emergency-contact details are operational personal data for authorized staff;
clients should treat the entire response as private.

All domain queries are constrained by gymId and memberId. Trainer and branch joins
verify the same gym. Payments and attendance must reference a subscription for
that same member and gym. Invalid subscription, payment or attendance reference
states fail the summary safely, with no partial data. Missing current branch is
explicitly nullable; missing/inactive/foreign trainer profiles are excluded from
currentTrainers.

## Subscription semantics and history

The server captures one current UTC calendar date for the response. Current means
`startDate <= today < endDate` and non-cancelled. Future renewals, expired and
cancelled periods are not current; creation time/ObjectId/current plan status do
not select eligibility. Two current candidates, an inconsistent lifecycle state,
invalid snapshots or broken renewal/plan tenancy cause a sanitized 500 response
rather than arbitrary selection.

Existing subscription snapshots remain authoritative, including when the plan
name, price, duration or active status later changes. The plan join verifies only
reference tenancy, not current commercial terms. Response status derives expiry
from the exclusive end date. A future renewal in history may be active/unexpired
while isCurrentlyActive=false, consistent with the existing lifecycle.

History sorts startDate descending and _id descending. It includes cancelled,
expired and future periods. Only immediate previousSubscriptionId is returned;
there is no recursion, nested renewal chain or history collection.

## Payment semantics and exact arithmetic

Only `status=succeeded` payments contribute to totals, counts and latest payment.
Pending/failed/cancelled records never contribute. Latest sorts paidAt descending
then _id descending. Successful totals cover all this member's subscriptions,
while the current-period balance sums successful payments for currentSubscription.id.
The price comes from pricePaiseSnapshot, never the mutable MembershipPlan.

All money is INR integer paise. Each successful amount must be a positive integer
within the existing Payment bound. MongoDB sums use Decimal128 conversion, then
BigInt verification before conversion to an exactly representable JSON integer.
Totals outside JavaScript's safe integer range fail closed rather than rounding.
Counts are also checked. Negative current-period balances, fractional/invalid
amounts or mismatched financial references produce a sanitized 500 according to
existing INVALID_FINANCIAL_STATE handling. No payments are modified or created.

## Attendance semantics

Completed visits are counted separately from open/cancelled records. Latest sorts
checkInAt descending then _id descending. Exactly one open visit sets currentlyCheckedIn
and currentAttendance; none produces false/null. Ambiguous open records fail safely.
Subscription and branch linkage is retained even if the member later transfers
branches, renews membership, or a branch becomes inactive. CurrentBranch resolves
the member's present branch, not a historical visit's branch. No attendance is
created/closed/rewritten by this endpoint.

## Validation, pagination and query cost

Strict Zod validates both ObjectIds and permits only `page` and `limit` query
parameters for subscriptionHistory. Defaults: page=1, limit=20; maxima: page=10000,
limit=100. Unknown parameters, client-supplied clocks, role/user/gym overrides,
Mongo operators, array/duplicate values and invalid pagination produce 400.
The current subscription and all totals are independent of the selected history page.

The service uses a fixed four aggregate queries (subscriptions, payments,
attendance and active trainer assignments), plus bounded authorization/profile/branch
lookups. No per-subscription payment query or per-trainer query is performed.
Subscription history returns at most limit items; current/open candidates are
limited to two to detect ambiguity, latest records to one. Active trainer details
are limited to 101 internally: up to 100 valid active assignments return in full;
an unexpectedly larger set fails safely rather than silently truncating it.

No new indexes are introduced. Existing gym/member subscription period, payment
member list, attendance member list and assignment member/status indexes narrow
queries; related ID lookups use primary-key indexes. Exact historical totals and
reference verification still scan this member's relevant history on MongoDB.
Start-date ordering, successful-payment selection and facet totals may require
in-memory sorting/scanning within that scoped set. Response size is bounded, but
processing cost grows with history. Offset pagination can be expensive at high
pages; no cache/Redis or denormalization is introduced in this milestone.

## Consistency and limitations

This is a read-time operational view, not an atomic multi-collection transaction
snapshot. Related records may change between its queries or immediately afterwards.
No locks are taken, and no request-wide serializability is claimed. Authorization
is checked at lookup time against persisted state. Related lookup failures return
one safe error without partial sections. Raw collection writes bypass domain
invariants; inconsistent references must be corrected through a separately reviewed
maintenance procedure. Deleted plan/subscription/branch references in historical
domains can therefore make the summary unavailable rather than inventing data.
Tests use temporary isolated MongoDB databases and never read the real .env.
