# Trainer/member operations — Milestone 24

This extends the existing TrainerMemberAssignment domain in
`src/modules/trainerAssignments/`. No new model, collection, lifecycle,
dependency or index is introduced. The original domain documentation is
[trainer-assignments.md](trainer-assignments.md).

## Endpoints

All paths below follow `/api/v1/gyms/:gymId`:

| Method | Path | Admin | Trainer | Member |
| --- | --- | --- | --- | --- |
| POST | /trainer-assignments | Create | Denied | Denied |
| GET | /trainer-assignments | Gym-scoped list | Self-scoped list | Denied |
| GET | /trainer-assignments/:assignmentId | Gym-scoped detail | Self-scoped detail | Denied |
| PATCH | /trainer-assignments/:assignmentId/deactivate | Deactivate | Denied | Denied |
| GET | /trainers/:trainerId/members | Gym trainer's members | Own active relationships | Denied |
| GET | /members/:memberId/trainers | Gym member's trainers | Own active relationship to assigned member | Denied |

The existing PATCH `/trainer-assignments/:assignmentId` with
`{"status":"inactive"}` remains available. The new `/deactivate` endpoint accepts
an empty body (or no body) and no query parameters. Both delegate to the same
existing service operation.

## Compatibility with established APIs

Milestone 24 is additive. Existing creation, list, detail and PATCH contracts
remain unchanged, including optional client-supplied assignedAt with its existing
timestamp validation, creation defaults, response DTOs and trainer history reads.
The original list still returns an empty list/zero count when a trainer supplies
another trainerId filter; the original detail/list may expose that trainer's own
inactive assignment history. These behaviors do not authorize the new views.

The stricter rules below apply only to the new scoped operational views.
Another trainer's path ID is rejected with 403 FORBIDDEN, and a historical
assignment alone never authorizes the member→trainers view. New trainer views
are active-only; admins can inspect inactive history. Read history is distinct
from current authorization. The new deactivation route is an admin-only alias
for the existing lifecycle service, preserving all old mutation behavior.

## Creation and lifecycle

Create requires TrainerProfile and MemberProfile IDs in the authorized gym.
Both profiles must be active; missing/foreign profiles return safe not-found
errors, inactive/suspended profiles are denied. UserAccount IDs cannot substitute
for trainer IDs. Status and gym are server-controlled; no profile, account or
access record is created or reactivated by assignment creation.

The existing partial unique `(gymId, trainerId, memberId)` active-relationship
index prevents duplicates, including concurrent creates. Conflicts use
`409 DUPLICATE_ACTIVE_ASSIGNMENT`. Inactive periods never become active again;
a new relationship period requires a new record.

Deactivation conditionally changes only an active record, sets endedAt once and
preserves gymId, trainerId, memberId and assignedAt. Retries/concurrent requests
preserve the winning endedAt. Historical assignments are not rewritten or deleted.
Reactivation is not supported.

## Scoped views and authorization

Every operation requires the existing active account/session, active GymAccess,
active Gym and explicit role checks. Services recheck persisted gym access even
for internal callers. Admin authority remains limited to the requested gym.

Trainer identity resolves from the authenticated account to exactly one active
TrainerProfile in that gym. Missing, inactive/suspended or ambiguous profiles
fail closed. A trainer cannot use a path/query identity to impersonate another
trainer. Trainer→members views reject another trainer's path ID. Member→trainers
views require a current active assignment and return only that trainer's own
relationship, including when the member has other trainers. They reveal no other
trainer's assignment data. Revocation removes access on subsequent requests.
Trainers cannot create/deactivate assignments; members cannot access these
operational endpoints.

Scoped-view query parameters are exactly status, page and limit. Default status
is active. Admins can request inactive historical relationships. Trainers may
only request active relationships. Page defaults to 1 (maximum 10000), limit to
20 (maximum 100). Unknown fields, operators, duplicate parameters, malformed IDs
and invalid pagination/status are rejected. Results sort by createdAt descending
then _id descending. Counts and returned rows apply the same tenant/reference
filters. Pagination appears in `meta.pagination`; envelopes retain success,
requestId, standard errors and Cache-Control: no-store.

## Response allowlists

Trainer→members rows contain memberId, memberCode, firstName, lastName, phone,
status, optional branchId, assignmentId, assignedAt, assignmentStatus and
optional endedAt. Member→trainers rows replace the member identifiers with
trainerId and trainerCode. Profile status is distinct from assignmentStatus.
These are intentionally smaller DTOs than the existing full profile serializers:
address, emergency contact, date of birth, account links and auth data are omitted.
No raw Mongo documents, internal IDs, credentials or sessions are exposed.

## Branches and profile lifecycle

Trainer and member may belong to different branches of the same gym. No
branch-equality/status rule is introduced. Profile branch transfers do not alter
assignment periods. Views show the current profile branch only if that branch
exists in the same gym; missing/foreign branch references are omitted.

Assignment state and profile state remain separate. Profile changes do not
automatically deactivate/reactivate assignments. Admins may inspect historical
relationships to inactive/suspended profiles. An inactive/suspended trainer
loses trainer self-access according to existing authorization rules.

## Performance, safety and limitations

Each scoped view uses a single assignment aggregation joining both profiles
with gym constraints before pagination/counts, and joining branches only for the
bounded page. Missing/corrupt cross-gym profile references are excluded rather
than exposed. No per-row database lookups or read-side writes are performed.
Existing indexes are reused.

Database failures return sanitized standard errors without partial data.
Authorization/profile checks observe state at lookup time; they are not a
multi-document transaction that locks administrative revocation for a request.
Offset pagination can shift between requests. Joined profile information reflects
current profiles, not historical snapshots. Raw writes bypass application
lifecycle validation and are unsupported as a production API.

Tests use owned temporary MongoDB processes, never the real .env or
development/production database. No scheduling, workouts, account provisioning,
automatic assignment synchronization or member self-service is introduced.
