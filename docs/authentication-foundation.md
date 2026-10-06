# Authentication foundation

No public registration, profiles, or full role authorization are implemented. The Gym/Branch and identity APIs retain their existing development bootstrap restrictions.

## Configuration

Required environment variables: `JWT_ACCESS_SECRET` (32–64 random bytes encoded as 64–128 hexadecimal characters), `JWT_ISSUER`, `JWT_AUDIENCE`, and the existing `MONGO_URI`. `.env.example` contains placeholders, never real secrets. The secret should be generated with cryptographically secure randomness and supplied through deployment configuration. Startup rejects missing configuration, weak/predictable patterns, and known placeholders; it never prints supplied secret values. Shape checks cannot prove randomness: use a cryptographic generator, not a memorable phrase encoded as hex.

Generate a signing secret locally with this command, then supply its output through a secret manager or your ignored local configuration. Do not commit the output or paste it into logs/docs:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The real `.env` is not read or changed by security tests. Existing secrets that do not meet the new representation will fail startup until an operator replaces them. Replacing the signing secret invalidates existing access JWTs; no automatic signing-key migration is performed.

Lifetime settings are integer seconds:

- `ACCESS_TOKEN_TTL_SECONDS`: default 600, maximum 900.
- `REFRESH_TOKEN_TTL_SECONDS`: default 604800 (7-day idle window), maximum 2592000.
- `SESSION_TTL_SECONDS`: default 2592000 (30-day absolute limit), maximum 7776000.

Refresh credentials are opaque 32-byte cryptographically random values. Only SHA-256 digests are persisted. No separate refresh signing secret is necessary for these high-entropy credentials. JWT signing/verification explicitly uses HS256 with configured issuer and audience. Payload contains only account subject, session ID, and standard issuer/audience/time claims; roles and personal information are excluded.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/v1/user-accounts/:userId/password` | Bootstrap-only initial password provisioning |
| POST | `/api/v1/auth/login` | Login with email/password |
| POST | `/api/v1/auth/refresh` | Rotate refresh credential |
| POST | `/api/v1/auth/logout` | Revoke current session and refresh chain |
| GET | `/api/v1/auth/me` | Bearer-authenticated current identity and active gym access |

Passwords are accepted only at provisioning/login boundaries, never logged or echoed. Initial provisioning accepts `password` of 15–128 characters, hashes with Argon2id (64 MiB memory, three iterations, parallelism one), and refuses replacement of an existing hash. Whitespace-only, short repeating patterns, and a small local common-password blocklist are rejected. Passphrases are preserved exactly, including spaces; no character-class requirements are imposed. The local blocklist is not a comprehensive breached-password dataset. It does not activate an inactive account. Existing passwordless accounts need provisioning before they can log in. No reset/change/recovery workflow exists yet.

Provisioning and all existing bootstrap domain routes are absent from the main API listener, even when bootstrap is enabled. They require `ENABLE_BOOTSTRAP_ROUTES=true`, development/test, and a separate listener bound to `127.0.0.1` on `BOOTSTRAP_PORT` (default 3002). Direct loopback checks remain as defense in depth. Configuration rejects bootstrap enablement in staging/production and equal API/bootstrap ports.

Local development/bootstrap clients must use `http://127.0.0.1:3002` for provisioning. Never publish, container-forward, or reverse-proxy this port. The public reverse proxy must target only the main API port. A local proxy intentionally forwarding the dedicated listener still defeats its local-only boundary; localhost is not user authorization. Production requires a future reviewed provisioning/activation workflow.

## Native client flow

Login body: `email`, `password`, optional `client: "mobile"`. Without a client field, requests without Origin use native delivery. The API returns safe user/gym-access DTOs, access JWT, refresh credential, token type, and access lifetime. Store the refresh credential using platform-backed secure storage and keep access credentials in memory where practical.

Refresh body: `refreshToken`. The API rotates it and returns replacement credentials. Logout accepts a Bearer access JWT, a refresh credential, or both. Refresh credentials remain usable for logout when the access JWT has expired. Signed expired JWTs may identify a session for revocation only; normal authentication still enforces expiration.

All presented credentials are verified before revocation. Matching credentials revoke one session; credentials for different verified sessions revoke both. Invalid credentials return a generic authentication error without clearing cookies or reporting success. Known already-revoked sessions may be logged out again successfully. Unknown credentials return the same generic authentication error without revealing session details. Refresh and cookie clearing follow successful server-side revocation.

Native credential delivery is rejected for requests carrying a browser Origin header. Transport choice is checked against the session. These remain bearer tokens; transport labels are not device binding or a defense against a non-browser caller forging Origin.

## Web client flow

Login body: `email`, `password`, optional `client: "web"`. Without a client field, requests carrying Origin use web delivery. Origin must match an explicit `ALLOWED_ORIGINS` entry. Access JWT is returned in JSON; refresh credential is delivered only in a `__Secure-gymRefresh` cookie with Secure, HttpOnly, SameSite=Strict, and `/api/v1/auth` path.

Refresh/logout use that cookie with an empty JSON body and trusted Origin. Cookie credentials and body credentials cannot be mixed. Cookies are always Secure, including development; use local HTTPS for web clients rather than weakening cookie security. Deploy frontend/API on a same-site HTTPS topology compatible with SameSite=Strict. Cross-site cookie deployment is outside this milestone.

CORS now enables credentials only for exact allowlisted origins. Use browser requests with credentials enabled; never persist refresh credentials in localStorage. Responses are marked Cache-Control: no-store.

## Sessions, rotation and revocation

AuthSession stores account reference, transport, active/revoked status, absolute expiry, idle expiry, last rotation/use time, and the current token digest. RefreshTokenRecord stores session reference, token digest, expiry, used/revoked markers, replacement reference, and cleanup time. No device/IP/browser fingerprint is retained.

Login creates one session per device/login. Every protected request verifies JWT algorithm/signature/issuer/audience/expiry and current account/session state. Logout or replay revocation therefore invalidates existing access JWTs immediately. `/me` and login expose only active GymAccess records for active Gyms. An active account with no eligible gym access can still authenticate and receives an empty list; full capability/ownership enforcement remains future work.

Rotation pre-persists a random replacement record, then conditionally replaces the current digest in a single atomic session update. The previous record is marked used and linked to its replacement. Session state is the authoritative gate: crashes between writes cannot create two usable chains. Failures after the session switch revoke the session; unissued orphan records are harmless and expire through cleanup. This works with the existing standalone isolated MongoDB test strategy without requiring multi-document transactions.

Reuse or concurrent rotation of the same old token revokes the affected session. Clients must serialize refresh requests; no replay grace period is implemented. Other sessions remain unaffected. Rotation extends the idle deadline only up to the original absolute expiry. Consumed token digests remain until absolute session expiry so reuse remains detectable. TTL indexes perform cleanup; application checks enforce expiry independently of TTL timing.

## Limits and operational scope

Login: 30 requests per IP per 15 minutes. Refresh: 60 per IP per minute. Password provisioning: 20 per IP per 15 minutes, behind bootstrap restrictions. General API limits remain in place. Limiter state is per process; deploy shared enforcement before scaling across instances. Proxy trust remains disabled pending reviewed deployment configuration.

No logout-all, password recovery, email verification, invitation delivery, signing-key rotation, or role authorization middleware is implemented. These need separate approved milestones before production onboarding. Existing data is retained. Startup adds authentication session/token indexes, then verifies the normalized-email and user/gym unique identity constraints independently of bootstrap mode. Missing identity constraints stop startup before either HTTP listener opens.

Before the first production startup, run the explicit additive identity migration:

```sh
npm run db:indexes
```

This command uses the configured target database. Run it deliberately as a deployment step; security validation runs it only against isolated test MongoDB with an explicit synthetic environment. It creates declared UserAccount/GymAccess indexes and verifies uniqueness without dropping unrelated indexes or rewriting data. Existing duplicates/conflicting index definitions cause failure and require reviewed remediation. Development/test bootstrap startup invokes this same additive mechanism for local convenience.

Dummy Argon2 verification hashing is initialized and awaited before either HTTP listener opens. Initialization errors stop startup and clean up the database connection. Security events log login outcomes, refresh reuse, session revocation, and logout using explicit safe fields and request IDs, never credentials.

## Testing

`npm test` generates independent random JWT secrets and uses owned temporary loopback MongoDB processes. It never reads the real `.env` or writes to development/production databases. Coverage includes Argon2id, generic login failures, JWT rejection cases, transport/Origin protections, refresh rotation/reuse/concurrency, expiration, immediate revocation, status/access changes, bootstrap gates, rate limits, log redaction, and production-mode startup/shutdown against isolated MongoDB. Security regression coverage also includes credential conflicts, expired-token logout, deterministic refresh/logout races, post-rotation write failure, account/session mismatch, absolute expiry bounds, concurrent provisioning, distinct Argon2 salts/parameters, weak-secret rejection, missing production identity indexes, additive index preservation, and correlated credential-free security events.
