# Member self-service — Milestone 26

The `/me` endpoints use the authenticated member identity. The client cannot
choose another member. These are dedicated read-only APIs; existing staff APIs
retain their role checks and contracts.

## Endpoints

| Method | Path | Data |
| --- | --- | --- |
| GET | /api/v1/me/gyms/:gymId/profile | Own profile and safe current branch |
| GET | /api/v1/me/gyms/:gymId/membership | Current membership and bounded subscription history |
| GET | /api/v1/me/gyms/:gymId/payments | Successful payment history and exact collected total |
| GET | /api/v1/me/gyms/:gymId/attendance | Stored visit history |
| GET | /api/v1/me/gyms/:gymId/trainers | Current active trainer relationships |

All responses use existing `{success,data,meta}` envelopes, requestId and
Cache-Control: no-store. Collection pagination is in `meta.pagination`.

## Identity and gym scope

All five operations use one shared resolver. Existing authentication verifies
the active global account and session. The resolver rechecks current database
GymAccess and Gym state, explicitly requires role=member, then queries
MemberProfile by authenticated UserAccount ID and requested gym. Exactly one
profile must exist and it must be active. Ambiguity includes inactive duplicates;
the resolver never guesses among multiple links. Missing/null/mismatched links,
inactive/suspended profiles, inactive/suspended access and inactive gyms fail closed.

Admin/trainer access to a gym cannot impersonate a member, even if a profile is
linked there. One global account may independently resolve different member
profiles across gyms with active member access. Every data query uses that
resolved gym/profile pair. No body/query/path memberId or other resource ID is
accepted as a self-service identity. Foreign IDs, identity overrides, operators
and unknown query/body fields are rejected. Revocation denies subsequent gym reads.
No status/profile/access changes happen as a read side effect.

## Profile

Data is `{member,currentBranch}` and reuses Member Summary's safe profile DTO.
Member fields include id, memberCode, firstName, lastName, phone, status, optional
gender/dateOfBirth/address/emergencyContact and existing timestamps. Nested
address/contact fields are allowlisted. userId, credentials, session/security
fields and raw Mongo internals are omitted. Current branch ID/name/status and
allowlisted address/contact are returned only if the branch belongs to the gym;
missing/foreign branches produce null. This is the member's own current profile,
not another user's data.

## Membership

Data is `{currentMembership,subscriptions}`. Existing Member Summary subscription
aggregation and validated DTOs are reused. Current selection uses UTC calendar
today and `[startDate,endDate)`, excludes cancelled, expired and future starts,
returns null if none, and fails closed on multiple effective periods or
inconsistent lifecycle/reference state. Current selection is independent of the
history page, including an empty page.

Subscription DTOs include id, membershipPlanId, planNameSnapshot,
durationDaysSnapshot, pricePaiseSnapshot, startDate/endDate, derived status,
isCurrentlyActive and previousSubscriptionId. Terms come from immutable stored
snapshots; mutable plan name/price/duration/status cannot rewrite them. Plan and
predecessor lookups validate tenancy only. No purchase, cancellation or renewal
operation is exposed here.

## Payments

Data is `{payments,totalSuccessfulPaidPaise}`. Only succeeded payments for the
resolved member/gym count; pending/failed/cancelled payments are excluded. Existing
Member Summary payment reference checks, amount validation, Decimal128 aggregation
and exact-total conversion are reused. Each linked subscription must belong to
the same member/gym; inconsistent references or invalid/fractional amounts fail
closed instead of leaking unrelated data.

Rows expose only id, subscriptionId, amountPaise, paymentMethod, paidAt and optional
transactionReference. Recorder identity, notes and auth data are omitted. Total
collected money covers all matching successful history, independent of the page.
All output amounts are exact integer INR paise. No balance calculation or new
accounting policy is introduced. Payment records are never mutated.

## Attendance

Data is an array of visits with id, branchId, checkInAt, checkOutAt, status and
durationMs. The existing Attendance DTO computes duration from stored timestamps;
open visits have null checkout/duration. Recorder identity and unrelated member
information are omitted. Historical branch IDs come from stored visit records,
not the member's later branch affiliation. Existing gym/member/subscription/branch
reference validation is preserved. Missing/foreign/corrupt references fail safely;
the API does not fabricate historical relationships or repair data.

## Trainers

Data is a paginated array of trainerId, trainerCode, firstName, lastName, phone,
optional specializations/branchId, assignmentId and assignedAt. Existing Member
Summary joins require active assignments and active same-gym TrainerProfiles.
Inactive historical assignments, inactive profiles and unrelated relationships
are excluded before pagination/counting. Foreign/missing trainer branch references
are omitted. No assigned trainer returns an empty array. Member status/access
authorization remains separate from trainer assignment status.

## Pagination, performance and limitations

Profile accepts no query parameters. All other endpoints accept only page and
limit: page defaults to 1 (maximum 10000), limit defaults to 20 (maximum 100).
History/status/date/resource-ID filters are not introduced in v1. GET bodies must
be empty. Sorts use descending startDate for subscriptions, paidAt for payments,
checkInAt for attendance and assignedAt for trainer relationships; all use
descending _id as the deterministic secondary key.

The self-service module orchestrates existing Member Summary read helpers; it
does not fake staff identities or broaden staff role allowlists. Each history
endpoint performs one aggregation with bounded rows and scoped count/summary
facets. Joins run in MongoDB without per-row Node lookups. Existing indexes are
reused; no model, index, dependency, cache or background job is added.

Independent reads observe state at lookup time and are not a transactional
snapshot that locks concurrent lifecycle changes. Offset pages may shift.
Existing integrity checks can reject corrupt legacy data. The member-link query
uses existing indexes; a new index should follow measured query demand. Totals
and counts can scan all matching history while response rows stay bounded.

No profile/password/email edits, recovery, membership purchase/cancellation,
payment creation, assignments or attendance check-in/checkout are implemented.
Inactive trainer assignment history is not available. Tests use owned temporary
MongoDB instances and never real .env/development/production data.
