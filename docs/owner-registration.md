# Public owner registration

`POST /api/v1/auth/register-owner` on the normal API listener, without authentication or bootstrap enablement.

```json
{
  "ownerFullName": "Alex River",
  "email": "owner@example.invalid",
  "password": "<your-private-passphrase>",
  "gymName": "Example Gym",
  "gymContactPhone": "+91 9876543210"
}
```

The password above is a placeholder, not a recommended password. Use the existing 15–128-character password policy: predictable/common passwords and short repeating patterns are rejected. The original password is preserved for hashing; never put a real password in documentation or diagnostics.

Strict input: ownerFullName is trimmed, 1–120 characters; email follows the existing validated 254-character maximum and normalized-email uniqueness; gymName is trimmed, 2–120 characters. Gym-name uniqueness uses the existing NFKC/whitespace/case-normalized nameKey. Optional gymContactPhone follows the existing Gym contact phone policy (7–25 characters; allowed phone characters and at least seven digits); omit it when blank. All other fields, including confirmPassword, roles, IDs, status and ownership claims, are rejected.

The service hashes once outside the retryable transaction. One snapshot/majority-write transaction inserts a new active UserAccount, active Gym, and active admin GymAccess; all three creates receive the same session. It never attaches an anonymous request to an existing account. A failure aborts all inserts; unsupported transaction storage returns 503 OWNER_REGISTRATION_STORAGE_UNAVAILABLE. A replica set or other transaction-capable deployment is required. No standalone fallback exists.

Successful response: HTTP 201, Cache-Control: no-store.

```json
{
  "success": true,
  "data": { "accountCreated": true, "gymCreated": true },
  "meta": { "requestId": "current-request-id" }
}
```

No access/refresh tokens, account/gym documents or password hashes are returned. Flutter returns to Login with a success notice; ordinary login establishes the existing secure session. If the registration response is lost after commit, sign in normally. There is no anonymous operation-status endpoint or automatic retry. Duplicate email is HTTP 409 DUPLICATE_EMAIL; duplicate normalized gym name is HTTP 409 DUPLICATE_GYM_NAME. Neither returns existing gym/account details. Validation, unexpected errors and request IDs use the existing centralized envelope.

Five registration attempts per client IP per 15 minutes are allowed, including invalid requests, in addition to the existing global limiter. The limiter uses in-memory process storage: instances/restarts do not share quotas. A shared store and reviewed proxy configuration are required when deploying multiple instances. This does not weaken existing auth limiters or bootstrap restrictions.

Normal server startup creates Gym indexes independently of bootstrap enablement, including gym_name_unique. Existing UserAccount/GymAccess unique-index verification remains fail-closed; a fresh database still needs the existing additive identity index migration. Conflicting existing gym names stop index creation/startup; there is no automatic cleanup or destructive index synchronization.

New owners can log in immediately in this v1. Email has **not** been verified. Email verification, password reset, and additional public-launch abuse controls are future work before broad public launch. No owner-specific parallel authorization system, member/profile records, branches, plans, payments or photos are created. Existing administrators retain their access.

Backend tests use owned temporary MongoDB databases, never .env or development data. Flutter registration uses its public API client, keeps passwords only in the form/request memory, sends no confirmation-password field, and neither writes credentials nor modifies saved member/payment/renewal recovery operations.
