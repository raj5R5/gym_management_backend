# Identity foundation bootstrap API

UserAccount is the global account identity. GymAccess links one account to one Gym with exactly one role. No passwords, login, authentication, tokens, MemberProfile, or TrainerProfile exist in this milestone.

## Local provisioning only

The existing `ENABLE_BOOTSTRAP_ROUTES=true` flag and development/test environment gate apply to these routes. Direct loopback clients only; staging/production never mount them. Responses include `X-API-Mode: development-bootstrap`. Do not expose the development process through a public proxy or tunnel.

Roles submitted here are explicit local operator provisioning instructions. They are validated allowed values and stored in GymAccess, never accepted as evidence that a caller has permission. These endpoints provide no production authorization. Before production provisioning is enabled, authenticated account status, actor GymAccess, capabilities, and authorized scope must be checked server-side.

## Endpoints

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/user-accounts` | Create account |
| GET | `/api/v1/user-accounts` | List accounts |
| GET | `/api/v1/user-accounts/:userId` | Inspect account |
| POST | `/api/v1/gyms/:gymId/access` | Provision GymAccess |
| GET | `/api/v1/gyms/:gymId/access` | List access within Gym |
| GET | `/api/v1/gyms/:gymId/access/:accessId` | Inspect access within Gym |

No update or delete operations are implemented. Lists use the existing bounded `page`/`limit` query and `meta.pagination` response.

## Account contract

Create with required `email`, optional `displayName` (trimmed, 1–120 characters), and optional `status` (`active`, `inactive`, `suspended`; defaults to `inactive`). Email is trimmed and validated, with a 254-character maximum. The original trimmed case is retained for display; `normalizedEmail` is derived server-side by lowercasing and uniquely indexed globally. Dots and plus-tags are preserved. Internal normalized email, MongoDB fields, and version keys are omitted from DTOs.

`displayName` is a minimal identity label, not a Member or Trainer profile. No role or gym ownership is stored on UserAccount.

## Access contract

Create with required `userId` and `role` (`admin`, `trainer`, `member`), and optional `status` (`active`, `inactive`, `suspended`; defaults to `inactive`). Parent `gymId` comes from the validated URL, never from the body. The service verifies both Gym and UserAccount exist before persisting. All resource inspection and lists include gym scope.

Account status and access status are independent. Local bootstrap provisioning may store an active access record for an inactive/suspended account; it does not activate the account or authorize any operation. Future authentication/authorization must check both statuses. Inactive/suspended access still reserves the user/gym pair, preventing duplicate roles.

Strict Zod schemas reject unknown fields, including normalized email, ownership, passwords, permissions, timestamps, and body-supplied `gymId`. Identifiers must be 24 hexadecimal characters.

## Integrity and errors

- Unique account normalized email; creation-order listing index.
- Unique `(userId, gymId)` pair; supports user access lookups.
- Gym-scoped creation-order listing index.
- Immutable GymAccess user/gym references.
- Explicit bootstrap index creation before HTTP startup, without dropping existing indexes.
- Duplicate email returns 409 `DUPLICATE_EMAIL`.
- Duplicate user/gym pair returns 409 `DUPLICATE_GYM_ACCESS`.
- Missing references return 404 `GYM_NOT_FOUND` or `USER_ACCOUNT_NOT_FOUND`.
- Missing/out-of-scope access returns 404 `GYM_ACCESS_NOT_FOUND`.
- Invalid input returns 400 `VALIDATION_ERROR`.

Indexes reject preexisting conflicting data; no automatic data cleanup is performed. Reference integrity is enforced by services, not MongoDB foreign keys. Direct database deletion bypasses these service checks; deletion APIs are absent.

## Tests

`npm test` uses the existing isolated MongoDB helper: an owned loopback mongod process, temporary directory, and random test database. It never reads local `.env` or modifies existing databases. Provide `mongod` on PATH, `MONGOD_BINARY`, or the existing test executable cache. No new packages are needed.
