> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Authorization/RBAC foundation — Milestone 8

This milestone adds reusable server-side authorization only. Existing bootstrap
routes retain their dedicated loopback listener, explicit enablement, and
development/test restrictions. No authenticated business endpoints, new models,
capability contracts, or Flutter changes are introduced.

## Authority and request order

`UserAccount` represents account identity. `GymAccess` is the source of the
account's role within a specific gym. There is no global admin role or implicit
role hierarchy. One account can be admin in one gym and member in another.

Use this order when implementing a reviewed protected endpoint:

1. Existing `authenticate(authService)` verifies the JWT, current session, and
   current active account. Never populate `req.auth` from request data.
2. Validate the endpoint's request parameters/body with its Zod schemas.
3. `requireGymAccess` resolves the requested `req.params.gymId` against persisted
   active GymAccess and an active Gym.
4. `requireRoles(...allowedRoles)` checks an explicit server-defined role allowlist.
5. `requireBranchAccess`, when operating on an active branch, queries the branch
   using both its ID and the previously authorized gym ID.
6. Services enforce resource-specific ownership/assignment and constrain every
   read/write to the authorized scope.

Factories:

```js
const { createAuthorizationService } = require('./modules/authorization/authorization.service');
const { createAuthorizationMiddleware } = require('./middleware/authorize');

const authorizationService = createAuthorizationService({ GymAccess, Gym, Branch });
const authorization = createAuthorizationMiddleware(authorizationService);
// For a reviewed admin-only operation, use authorization.requireRoles('admin').
// Use multiple roles explicitly when the operation's approved policy allows them.
```

The allowlist is application code, never a request parameter, JWT claim, or
client-supplied capability. Empty allowlists and unknown role names fail during
middleware construction. Even admin is denied when an operation's allowlist
does not include admin. A role middleware without preceding gym authorization
fails closed. All role checks in this foundation are gym-scoped: they require a
valid `req.params.gymId` matching the authorization context. There is no
non-gym-scoped fallback. Direct service calls must pass the selected gym ID as
`requireRoles(auth, authorization, allowedRoles, gymId)`.

## Scope and status checks

The selected URL gym ID is input to validation, not proof of ownership.
Authorization queries the current GymAccess on every request; access removal,
role changes, and inactive/suspended status take effect without issuing a new JWT.
The layer does not cache grants or trust login/`me` snapshots, role claims in JWTs,
body/query roles, or gym/role headers.

`req.authorization` is an immutable minimal context:

- `userId`: authenticated account ID.
- `gymId`: authorized gym ID.
- `gymAccessId`: persisted access record ID.
- `role`: persisted gym role.
- `branchId`: added only after successful branch authorization.

It contains no passwords, token values, or account personal information. Gym
authorization replaces prior scope so a stale context cannot survive a denied
gym lookup. Role and branch guards require an authenticated context belonging
to the same account. Contexts must contain valid canonical account, gym, and
GymAccess IDs plus a supported role. Role guards reject missing, malformed, or
different gym scope in the current URL. Failed role/branch checks clear
`req.authorization` before passing the error to centralized handling.

Branch queries include `{ _id: branchId, gymId: authorization.gymId }`. Access to
both gyms still does not allow a branch to be reached through the wrong gym's
URL. Branch scope currently derives from GymAccess; no narrower per-branch grant
model exists. Inactive branches are denied by the active-branch guard. A future
admin reactivation workflow needs an explicitly reviewed status policy rather
than silently weakening this guard.

## Responses and failure behavior

All failures use the existing error envelope and request ID:

| Condition | HTTP | Code |
| --- | --- | --- |
| Missing/invalid/expired/revoked authentication, inactive account | 401 | INVALID_AUTHENTICATION |
| Malformed gym/branch ID | 400 | VALIDATION_ERROR |
| No active access, inactive/missing gym, disallowed/unknown role | 403 | FORBIDDEN |
| Missing branch or branch belonging to another gym | 404 | BRANCH_NOT_FOUND |
| Inactive branch or incompatible authorized scope | 403 | FORBIDDEN |
| Unexpected database failure | 500 | INTERNAL_SERVER_ERROR |

Missing/inactive/unrelated gyms share a denial rather than disclosing arbitrary
gym existence. Branch errors do not reveal which other gym owns a resource.
Database errors fail closed without exposing internal messages or credentials.

## Boundaries and testing

Authentication plus a permitted role is not sufficient authorization for every
future resource. Member ownership and trainer assignment require the relevant
future profiles/relationships and service checks; those models do not exist in
this milestone. Do not treat gym access as blanket access to member data.
Business capability mappings and public Gym/Branch route policies remain for
review before those endpoints are exposed.

Checks provide current database state at their execution time; they do not lock
account/access records across the entire request. Future sensitive writes must
consider status-change races and enforce the required predicates in data access.

`tests/integration/authorization.test.js` uses private `/test/...` probes with
the real authentication and authorization middleware, real Mongoose models,
independent test secrets, and an owned temporary MongoDB process. These probes
are not mounted by the application or offered as API contracts. The suite never
reads the real `.env` or writes to development/production databases.
