> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Member Management — Milestone 9

MemberProfile is a person's gym-domain record, separate from the login identity
in UserAccount. Members can exist without an account. Creating a profile does
not create passwords, accounts, GymAccess, or any other domain records.

## Fields and tenant boundary

| Field | Definition |
| --- | --- |
| gymId | Required immutable Gym reference; derived from authorized URL scope |
| userId | Optional immutable UserAccount reference; trusted server-side relationship only |
| branchId | Optional Branch reference belonging to the same gym; mutable |
| memberCode | Required immutable gym-facing code, trimmed and uppercased |
| firstName / lastName | Required trimmed strings, 1–80 characters each |
| phone | Required string, up to 25 characters; optional leading +, digits/spaces/parentheses/hyphens; 7–15 digits |
| dateOfBirth | Optional calendar date in YYYY-MM-DD, not in the future; stored at UTC midnight |
| gender | Optional female, male, non_binary, other, prefer_not_to_say |
| address | Optional object: required line1, city, uppercase two-letter countryCode; optional line2, state, postalCode |
| emergencyContact | Optional object: required name/phone, optional relationship |
| status | active (default), inactive, suspended |
| createdAt / updatedAt | Server-generated timestamps |

The gym is the authoritative tenant boundary. IDs, roles, and permissions supplied
in bodies never grant authority. All read/update queries include the authorized
gym ID. Branch lookup includes both branch ID and gym ID and requires an active
branch when assigning it. Moving branches within a gym or removing a branch is
supported; moving gyms is not.

Code format: 2–32 ASCII characters, first character A–Z or 0–9; remaining
characters A–Z, 0–9, underscore or hyphen. Example: ` gym001 ` becomes `GYM001`.
MongoDB enforces unique `(gymId, memberCode)` through `member_gym_code_unique`.
The same code is valid in another gym. Codes are not generated automatically or
released when a member is deactivated. Additional indexes support gym lists and
gym/status lists sorted by creation time and ID. Startup adds declared member
indexes without deleting unrelated indexes; conflicting existing data stops
startup rather than silently skipping uniqueness.

HTTP create/update strictly reject `userId`, `gymId`, `role`, account/access
status, credentials, unknown fields, and future-domain fields. This resolves the
optional identity relationship without introducing public linking or onboarding.
The service's optional `linkedUserId` argument is reserved for trusted server
callers, validates an existing UserAccount, and is never forwarded from HTTP
input. A later milestone must define the approved linking/onboarding policy.
Email and authentication credentials remain owned by UserAccount.

## Protected API and authorization

| Method | Path | Allowed roles |
| --- | --- | --- |
| POST | /api/v1/gyms/:gymId/members | admin |
| GET | /api/v1/gyms/:gymId/members | admin, trainer |
| GET | /api/v1/gyms/:gymId/members/:memberId | admin, trainer |
| PATCH | /api/v1/gyms/:gymId/members/:memberId | admin |

Authentication precedes gym authorization and explicit role checks. GymAccess
and Gym must be active. Services re-resolve gym access so a stale authorization
context is insufficient. Missing/inaccessible gyms return 403. Missing members
or branches, including records belonging to another gym, return their generic
404 errors. Validation returns 400; duplicate gym/code returns 409
`DUPLICATE_MEMBER_CODE`. All use the existing error envelope and request ID.
There is no DELETE or alternate unauthenticated member route. Member routes are
protected even on the bootstrap listener; existing Gym/Branch bootstrap routes
retain their restrictions. Member responses use Cache-Control: no-store and
explicit DTOs without UserAccount internals.

Example create body:

```json
{
  "memberCode": "GYM001",
  "firstName": "Alex",
  "lastName": "River",
  "phone": "+91 9876543210",
  "status": "active"
}
```

PATCH supports only names, phone, branch, date of birth, gender, address,
emergencyContact, and status. An empty update is rejected. Optional fields can be
cleared with null. Nested address/emergencyContact updates replace the entire
object and must include its required fields. Gym, account link, and member code
are immutable. Mongoose query updates strip immutable field changes; the HTTP
boundary rejects them explicitly. Updating other fields does not require an
existing unchanged branch to remain active; new assignments always do.

All three member statuses can transition between one another for v1. Status is
member-domain lifecycle, not account or GymAccess status. Deactivation/suspension
never deletes or changes an account/access grant. Admins/trainers may inspect
inactive/suspended profiles; members have no profile self-access in this milestone.
Trainer reads are gym-wide under the explicitly approved v1 policy, not invented
assigned-member access.

## Lists

Query parameters are limited to `page`, `limit`, `status`, and `search`:

- page defaults to 1, maximum 10000; limit defaults to 20, maximum 100.
- status is optional active/inactive/suspended.
- search is optional trimmed text of 1–100 characters. It performs a
  case-insensitive literal substring match on code, first name, last name, phone.
  Regex characters are escaped; MongoDB operators/arbitrary filters are rejected.
- Sort is createdAt descending, then _id descending for deterministic ties.
- Response data is a list; `meta.pagination` contains page, limit, total, alongside
  requestId. Counts and filters are scoped to the same authorized gym.

## Scope and limitations

No membership plans, subscriptions, payments, attendance, workout data, trainer
assignments, notifications, dashboards, onboarding, or member self-access are
implemented. Sensitive profile data is visible only to the approved staff roles.

Substring search may scan many records within a gym; a dedicated search strategy
and cursor pagination can follow measured scale needs. Offset pages and separate
count/list reads are not a consistent snapshot during concurrent writes.
Authorization/reference checks are not multi-document transactions; they check
state at query time and cannot lock out a concurrent direct database change.
Future branch deletion/status workflows and identity linking must address their
own concurrency and reference integrity. Direct raw MongoDB writes bypass
application validation and must not be used as a provisioning interface.

Tests use the actual application routes and owned temporary MongoDB processes;
they never load the real .env or use development/production databases.
