# Trainer ↔ Member Assignment — Milestone 11

TrainerMemberAssignment is a relationship period between a TrainerProfile and a
MemberProfile in one gym. Profiles remain separate from accounts and from each
other. Creating an assignment never creates or changes profiles, accounts,
credentials, branches or GymAccess records.

## Schema and lifecycle

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference, derived from authorized URL scope |
| trainerId | Required immutable TrainerProfile reference in that gym |
| memberId | Required immutable MemberProfile reference in that gym |
| status | Required active/inactive; creation always active |
| assignedAt | Required immutable timestamp; defaults to server time |
| endedAt | Optional server-managed timestamp set on deactivation |
| createdAt / updatedAt | Server-managed timestamps |

Create accepts only trainerId, memberId and optional assignedAt. An assignedAt
override must be a valid ISO timestamp with UTC/offset timezone, no later than
the current time. Status is server-controlled on creation.

PATCH accepts exactly `{ "status": "inactive" }`. Deactivation is atomic and
idempotent: only an active record transitions, and its endedAt is retained on
repeated/concurrent requests. No DELETE or reactivation endpoint exists. Create
a new record for another assignment period; historical inactive records remain.

The partial unique index `assignment_active_relationship_unique` covers
`(gymId, trainerId, memberId)` only when status is active. MongoDB therefore
prevents concurrent duplicate active relationships without blocking multiple
inactive periods. Many members per trainer and many trainers per member are
allowed; no exclusive trainer rule was approved. Additional indexes support gym,
trainer/status and member/status lists. Startup creates indexes additively and
fails if conflicting existing data prevents enforcing uniqueness.

## API and authorization

| Method | Path | admin | trainer | member |
| --- | --- | --- | --- | --- |
| POST | /api/v1/gyms/:gymId/trainer-assignments | Allowed | Denied | Denied |
| GET | /api/v1/gyms/:gymId/trainer-assignments | Gym list | Own assignments | Denied |
| GET | /api/v1/gyms/:gymId/trainer-assignments/:assignmentId | Gym record | Own assignment | Denied |
| PATCH | /api/v1/gyms/:gymId/trainer-assignments/:assignmentId | Deactivate | Denied | Denied |

Existing authentication and gym/role guards remain mandatory. Active GymAccess
and active Gym are required for every operation. Services independently recheck
persisted gym access, role and scope. No assignment-specific admin bypass exists.
Responses use existing success/error envelopes, requestId and no-store headers.
DTOs contain only assignment fields, with no populated personal/account data.

Trainer reads resolve exactly one active TrainerProfile using the authenticated
UserAccount ID and authorized gym ID. Zero or multiple active linked profiles
return 403. Client identity/role fields never establish ownership. The resolved
trainer ID constrains database reads; another trainer's assignment returns a
generic 404. Route-level read guards enforce ownership before controllers, and
services repeat the checks for direct internal callers and stale contexts.
No automatic account linking is implemented.

## Tenant, profile and branch rules

Creation requires both profiles to exist, be active and belong to the authorized
gym. Individual reads and deactivation reverify reference tenancy. Listing joins
both profiles with the same gym constraint before pagination/counting, excluding
missing or inconsistent cross-gym relationships even if introduced by raw writes.

Admin history reads/deactivation remain possible when referenced profiles become
inactive/suspended. An active linked trainer can inspect their relationship
history even if a referenced member is inactive; an inactive/suspended trainer
cannot self-read. Profile deactivation does not silently deactivate assignments.

Different branches of the same gym are allowed. No branch status or equality rule
is imposed on assignments, and branch changes do not mutate relationship records.

Validation failures are 400; unauthenticated requests 401; role/access/inactive
profile denials 403; missing/foreign resources 404; duplicate active relationships
409 `DUPLICATE_ACTIVE_ASSIGNMENT`. Missing assignments use `ASSIGNMENT_NOT_FOUND`.
Database failures fail closed with sanitized 500 responses.

## Listing

Only page (default 1, maximum 10000), limit (default 20, maximum 100), status,
trainerId and memberId are accepted. IDs must be 24-character hexadecimal IDs;
operators, arbitrary filters, duplicate parameter arrays and unknown fields are
rejected. Sort is createdAt descending then _id descending. meta.pagination
contains page, limit and total, scoped to the same filtered relationships.

Admin filters narrow the authorized gym. Trainer filters intersect self scope:
another trainerId returns an empty list/zero count and cannot expand authority.
Member filters narrow the trainer's own assignments. Inactive history can be
listed explicitly. Counts and records are produced in one aggregation.

## Scope, limitations and review

No workout plans, attendance, payments, scheduling, payroll, member self-access
or assignment-driven changes to existing member/trainer endpoint policies are
implemented. Existing member reads retain the previously approved v1 policy;
this milestone grants trainer self-read only on assignment endpoints.

Gym/access/profile checks are not a multi-document transaction. They observe
state at lookup time and cannot lock out a concurrent administrative/raw database
change. Unique active relationships and deactivation transitions are protected
atomically. Raw writes bypass lifecycle/reference validation and are unsupported
as an application interface. Future identity-linking policy should define link
uniqueness and add a measured lookup index if needed; current ambiguity denies
access without changing TrainerProfile's structure. Offset pagination and joined
counts can be costly at scale; optimization should follow measured demand.

Tests use owned temporary MongoDB instances without loading .env or accessing
development/production databases. Review covers tenant/ownership filtering,
strict validation, lifecycle concurrency, errors and protected bootstrap mounts.
