> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Gym and Branch development bootstrap API

These endpoints are unauthenticated development/bootstrap functionality. They are not production-authorized APIs. No account, GymAccess, or role handling exists yet.

## Enable locally

Set `NODE_ENV=development` and `ENABLE_BOOTSTRAP_ROUTES=true` in your ignored local `.env`, alongside your own `MONGO_URI`. Then run `npm start` or `npm run dev`.

The default flag is false. Routes are never mounted in staging or production, regardless of the flag. Enabled routes accept only direct loopback connections and return `X-API-Mode: development-bootstrap`. Do not expose this development process through a public reverse proxy or tunnel; a loopback proxy could forward public clients. Restrict use to a local development database.

Startup explicitly creates the Gym/Branch indexes before serving enabled bootstrap routes. It never drops existing indexes. Existing conflicting data will cause startup to fail until reviewed and corrected; no automatic cleanup or migration occurs.

## Endpoints

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/gyms` | Create Gym |
| GET | `/api/v1/gyms` | List Gyms |
| GET | `/api/v1/gyms/:gymId` | Get Gym |
| PATCH | `/api/v1/gyms/:gymId` | Update Gym |
| POST | `/api/v1/gyms/:gymId/branches` | Create Branch |
| GET | `/api/v1/gyms/:gymId/branches` | List Branches for Gym |
| GET | `/api/v1/gyms/:gymId/branches/:branchId` | Get Branch within Gym |
| PATCH | `/api/v1/gyms/:gymId/branches/:branchId` | Update Branch within Gym |

No deletion endpoints exist. Lists support `page` (1–10000) and `limit` (1–100, default 20), ordered by newest creation then ID. Pagination appears in `meta.pagination`.

## Contracts

Gym creation requires `name` (2–120 characters after trimming). Optional fields are `status`, `contact`, and `settings`. Status is `active` or `inactive`, defaulting to `active` on creation. Contact supports email and phone. Settings currently supports only an IANA `timezone`.

Branch creation requires `name` and `address`. Optional fields are `status` and `contact`. Address requires `line1`, `city`, and uppercase two-letter `countryCode`; optional fields are `line2`, `state`, and `postalCode`. Country codes are syntactically validated, not checked against a country catalog.

PATCH supports only the fields allowed on creation, with no default status applied. At least one field must be supplied. Nested contact/settings/address objects replace the previous object as a whole. A replacement address must include its required fields. Omitted top-level fields remain unchanged.

Bodies reject unknown fields, including `gymId`, ownership, role, internal IDs, and timestamps. Branch parent comes only from the validated URL, is checked against an existing Gym, and cannot be changed. Every Branch read/update is filtered by both branch ID and parent Gym ID. This enforces parent consistency, not user authorization.

Gym names are globally unique for this bootstrap milestone. Branch names are unique within their Gym, and can repeat across different Gyms. Internal name keys normalize Unicode (NFKC), whitespace, and case. Inactive names remain reserved. These are explicit v1 assumptions to revisit before production onboarding.

Successful responses use the existing success/data/meta envelope. Creates return 201; reads/updates return 200. Validation errors return 400 (`VALIDATION_ERROR`), missing resources return 404 (`GYM_NOT_FOUND` or `BRANCH_NOT_FOUND`), and name conflicts return 409 (`DUPLICATE_NAME`). Cross-Gym Branch access returns the same missing-Branch response.

## Isolated tests

Run `npm test`. Gym/Branch integration tests start their own MongoDB executable on loopback, using a fresh temporary data directory and random database name. They stop the process and remove its data afterward. They never read `.env`, `MONGO_URI`, or any existing development/production database.

Provide MongoDB Community `mongod` on PATH, or set `MONGOD_BINARY` to an existing executable. A test-only executable cached at `~/.cache/gym-management-tests/mongodb/bin/mongod` is also supported. For example:

```sh
MONGOD_BINARY=/path/to/mongod npm test
```

Tests fail clearly if no executable is available; they do not silently skip database checks or download/install a package. No in-memory MongoDB dependency is used.
