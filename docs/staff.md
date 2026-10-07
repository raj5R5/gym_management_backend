# Gym staff management — Milestone 20

This production administration API manages existing UserAccount identities and
GymAccess relationships. No Staff model, duplicate account collection, member
login provisioning, deletion or automatic TrainerProfile creation is introduced.

## Endpoints and authorization

Paths are under `/api/v1/gyms/:gymId/staff`:

| Method | Path | Operation |
| --- | --- | --- |
| POST | / | Create identity if needed and grant active staff access |
| GET | / | Paginated gym staff |
| GET | /:userId | One gym staff relationship |
| PATCH | /:userId | Update allowed identity/access fields |

All requests require the existing authenticated active account/session, active
GymAccess, active Gym and explicit **admin** role for the selected gym. Database
state remains authoritative; trainers and members are denied. Services recheck
scope. Mutations also verify the persisted acting admin and active account inside
the transaction. Routes use Cache-Control: no-store and existing success/error
envelopes. No DELETE, generic access API or separate staff token exists.

Bootstrap remains development-only provisioning infrastructure with its existing
listener restrictions. Staff endpoints require normal authentication even when
mounted by a bootstrap application; bootstrap enablement grants no staff power.

## Create

```json
{
  "email": "trainer@example.com",
  "displayName": "Example Trainer",
  "role": "trainer",
  "password": "<a passphrase meeting the existing authentication policy>"
}
```

All four fields are required. Role is admin or trainer. The existing password
validator (15–128 characters and predictable-password checks) and Argon2id hashing
service are reused unchanged. Email uses existing trim/lowercase identity rules;
dots and plus-tags are preserved. The server derives gym scope from authorized
route context and creates active account/access status, never trusting body gymId,
userId, normalizedEmail, passwordHash, statuses, permissions or timestamps.

For a new email, UserAccount and GymAccess are created atomically. For an existing
global email without access to this gym, only GymAccess is created. **Supplied
password and displayName are ignored for an existing identity**, preserving its
credentials, display name and global account status. The password must still pass
request validation. Existing inactive/suspended accounts and accounts without a
password are not implicitly activated/provisioned; active GymAccess alone does
not make such an identity login-capable. Recovery/password/global-status changes
require a separate authorized workflow.

Any existing access to this gym, including member, inactive or suspended access,
returns 409 DUPLICATE_GYM_ACCESS without replacement. The global email and
user/gym unique indexes remain authoritative. Concurrent creation in different
gyms can produce 409 DUPLICATE_EMAIL for one request; retrying after the winner
commits uses that identity and grants only the missing gym relationship.

The response is 201 with an explicit allowlisted representation:

```json
{
  "userId": "<accountId>",
  "email": "trainer@example.com",
  "displayName": "Example Trainer",
  "gymId": "<authorizedGymId>",
  "role": "trainer",
  "status": "active"
}
```

This object is inside `data`, with `success: true` and `meta.requestId`. No
password, passwordHash, normalizedEmail, sessions, tokens or Mongo internals are
returned. A newly created active identity can log in using the existing login
endpoint. Trainer-specific operations still require a separately linked active
TrainerProfile and assignments; creating a trainer access role does not create
those domain objects.

## Read and update

List supports only role, status, page and limit. Role is admin/trainer; status is
active/inactive/suspended. Defaults are page 1 and limit 20, maxima 10000 and 100.
Results sort by GymAccess.createdAt descending, then _id descending. Existing
`meta.pagination` contains page, limit and full filtered total. Member access is
excluded. Missing identity references are excluded from lists and individual
lookups return STAFF_NOT_FOUND. Missing/foreign/non-staff relationships return
404 without consulting or revealing unrelated global identities. Search is not
implemented. Unknown fields, duplicate query values, operators and invalid IDs
are rejected by strict Zod validation.

PATCH accepts a nonempty subset of:

```json
{ "displayName": "Updated Name", "role": "admin", "status": "active" }
```

Display name is trimmed and 1–120 characters. Role/status are the above enums.
**DisplayName belongs to the global UserAccount and is therefore visible in all
its gyms.** An authorized admin may update it only after resolving a staff
relationship in their gym. This is a shared identity display field, not a
per-gym alias. Role and status changes affect only the selected GymAccess;
UserAccount.status and other gyms' access remain unchanged. Member access cannot
be converted through this API. Email, password, security fields, identifiers,
permissions and timestamps cannot be changed or mass-assigned.

Inactive/suspended access remains stored and inspectable but fails active gym
authorization immediately, including with existing JWTs. It does not revoke the
user's global login or sessions for other gyms. Role changes are likewise enforced
from live database state. They never create/delete profiles or assignments.

## Transactions and last-admin invariant

Every staff mutation uses a snapshot transaction with majority write concern.
There is no non-transactional fallback: unsupported transaction storage returns
503 STAFF_STORAGE_UNAVAILABLE. Replica-set or sharded MongoDB is required for
mutations. Identity/access/name changes roll back together on failure.

Each transaction first performs a real increment of the gym's **existing __v
version field**, without changing its business timestamps. This is a concurrency
guard, not a persisted admin counter. All staff mutations for a gym share that
write, preventing snapshot write skew when separate admins are changed
concurrently. A version write on the acting active-admin access also conflicts
with concurrent removal of the acting administrator's authority. Driver
transaction retries re-evaluate permissions and invariants against fresh state.

After the intended changes, the transaction must find at least one active admin
GymAccess joined to an active UserAccount with a nonempty provisioned password
hash in the same gym. A disabled or unprovisioned global account cannot serve as
a usable backup administrator. Otherwise it aborts with
409 LAST_ACTIVE_ADMIN. This applies to self-demotion, self-inactivation,
self-suspension and changes to other staff alike. Another usable administrator
permits a self-change; the old token loses admin authorization immediately.
Concurrent requests cannot commit staff mutations reducing this count to zero.

Existing global-email and user/gym uniqueness and gym-prefixed list indexes are
reused. No schema/index migration, collection or dependency is added. Listing is
one aggregation with an allowlisted account join, pagination and total facets,
not a per-user query loop.

## Security events and limits

Structured staff.account_created, staff.access_created, staff.role_changed and
staff.status_changed success events are emitted after commit, with request ID,
actor/target IDs and gym ID only. Transaction retries do not duplicate those
events. No password, hash, token, email or display name is included. Existing
HTTP logging/redaction and API rate limiting remain in place.

Read pagination is not a durable snapshot. Transactions serialize administrative
staff writes per gym; unusually heavy provisioning may need measured performance
work. Audit logging uses the existing logger, not a transactional durable audit
collection or delivery guarantee. Global account suspension/recovery, email or
password changes, invitations and member login provisioning are separate future
workflows. Such future global-status workflows must coordinate with the usable
last-admin invariant; direct database writes and development bootstrap updates
are outside this production staff transaction protocol. The invariant does not
claim to repair existing corrupted access or protect unsupported raw writes.

Integration tests use owned isolated MongoDB processes (replica set plus a real
standalone failure case), never development/production credentials or data.
