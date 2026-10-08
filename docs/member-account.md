# Member account provisioning and activation — Milestone 25

MemberProfile creation != account provisioning. Account provisioning != account
activation. Activation != login. Revoking one gym's access != deleting the
global account.

## Endpoints and staff authorization

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /api/v1/gyms/:gymId/members/:memberId/account | Provision login access |
| GET | /api/v1/gyms/:gymId/members/:memberId/account | Inspect safe account/access state |
| POST | /api/v1/gyms/:gymId/members/:memberId/account/revoke | Disable this gym's member access |
| POST | /api/v1/account/activate | Set a password using a valid activation credential |

All three staff endpoints require existing authenticated active account/session,
active GymAccess, admin role and active Gym. Trainers and members are denied.
Services independently recheck persisted gym access. Member ownership is verified
within the authorized gym before reading global identity or mutating records.
Cross-gym/missing members return safe not-found responses.

Provisioning requires an active MemberProfile. Inactive/suspended members are
rejected and never automatically reactivated. GET/revoke can inspect/disable
historical access without changing profile status.

## Provisioning workflow

POST accepts exactly:

```json
{ "email": "member@example.com", "displayName": "Alex River" }
```

Email is mandatory and displayName optional. Existing UserAccount validation and
normalization are reused (trim/lowercase; no provider-specific dot/plus merging).
Phone is never substituted for email. Client userId/gymId/role/status/password,
passwordHash, normalizedEmail, token/session fields and unknown fields are rejected.
All endpoint query parameters are empty by contract. Revoke accepts an empty or
absent body. IDs must be strict 24-character hexadecimal ObjectIds.

For an unlinked member and unused email, a transaction creates an active global
UserAccount **without a password**, links MemberProfile.userId once, creates active
member GymAccess and creates an activation credential. Active account status
alone cannot log in without a valid password; existing authentication remains
authoritative. Member status is preserved.

An existing email is reused only when this MemberProfile already references that
exact UserAccount. Any mismatched link, unrelated existing identity, or another
member linked to that account in the same gym is a conflict; identities are not
attached, merged or stolen by email alone. An inactive/suspended existing account
is denied, never globally reactivated. Existing displayName/password are never
overwritten. An already-activated linked identity can gain member access without
a new activation token. Missing linked identities fail closed.

Any existing GymAccess in the requested gym, including inactive/suspended access,
produces `409 MEMBER_ACCOUNT_ALREADY_PROVISIONED`. No silent reissue or role/status
change occurs. A conflicting non-member role is never revoked by this workflow.

The successful provisioning response follows existing envelopes and contains:

```json
{
  "provisioned": true,
  "userId": "<accountId>",
  "email": "member@example.com",
  "gymAccess": { "role": "member", "status": "active" },
  "activated": false,
  "activationToken": "<one-time opaque credential>",
  "activationExpiresAt": "<UTC expiry timestamp>"
}
```

**The activation credential is returned once, only on successful provisioning.**
This is the approved manual handoff while messaging is out of scope. It is a
bearer credential: anyone holding it can activate the intended passwordless
account. Use HTTPS and a trusted private handoff to the intended member; do not
persist it in admin tooling, telemetry, URLs or shared logs. Responses use
Cache-Control: no-store. Already-activated reused accounts omit token/expiry.
No permanent password is chosen by or returned to administrators.

## Activation lifecycle and password setup

The credential contains 32 cryptographically random bytes encoded as 43 base64url
characters (256 bits of entropy). MongoDB stores only its SHA-256 digest, account,
gym/member references, expiry, usedAt and timestamps. Lifetime is 15 minutes from
issuance. Unique digest lookup and an expiration TTL index are created additively
at startup. TTL is cleanup only; expiration is explicitly checked on every attempt.

The member submits:

```json
{ "token": "<activation credential>", "password": "<member-chosen password>" }
```

The endpoint needs no admin authentication. Strict body/token validation and the
existing password policy apply: 15–128 characters and existing predictable-password
rejection. Existing Argon2id hashing parameters/tools are reused. The original
passphrase is preserved. Activation is protected by the existing auth limiter,
20 attempts per client IP per 15 minutes, plus the general API limiter.

Activation verifies an unused/unexpired credential, active gym, active matching
member identity, active member GymAccess and active passwordless UserAccount.
It consumes the credential and sets the password in one transaction. Exactly one
concurrent activation can succeed. An already-set password cannot be overwritten;
this is not a password-reset mechanism. Invalid, expired, used, revoked or
ineligible activation returns generic `401 INVALID_ACTIVATION_CREDENTIAL`.

Success returns only `{ "activated": true }` in the existing envelope. No password,
hash, activation credential/digest, JWT, refresh token or session is returned.
No session is automatically created. The member then uses normal login, refresh
rotation and logout.

## Transactions and race protection

Provisioning atomically commits account, access, set-once profile link and digest.
Failures roll back all writes. Activation atomically commits credential
consumption and password setup; failures roll back both. Revocation also runs
transactionally and invalidates unused credentials for that member/gym.

Transactions use snapshot reads and majority writes. Existing gym, member and
access documents receive real conditional writes to serialize concurrent
provisioning/revocation/activation and conflict with lifecycle changes. Credential
consumption and the passwordless-account update use conditional writes. Hashing
runs once outside transaction retries. Identity/access uniqueness remains enforced
by existing indexes. Transaction-unavailable storage returns
`503 MEMBER_ACCOUNT_STORAGE_UNAVAILABLE`; there is no fallback. Deployment needs
a MongoDB replica set or transaction-capable cluster.

MemberProfile's existing immutable userId schema remains unchanged. A trusted
internal conditional update can initialize only a null/missing identity link;
it cannot replace a populated link. Generic member APIs do not gain link editing.

## Revocation, status reads and multiple gyms

Revoke sets only this gym's member GymAccess inactive, consumes pending activation
credentials and preserves global UserAccount, MemberProfile and historical link.
Repeated revocation is safe. Activation cannot restore revoked access. Global
account status/password, other-gym access and all existing sessions are preserved.
Current database authorization rejects further operations in the revoked gym.
The user can continue using other authorized gyms and existing login/session APIs.

GET returns provisioned, optional userId/email, gymAccess (role/status or null),
and activated. It never returns credentials, token/digest, sessions or security
internals. Activated indicates an actual stored password credential; provisioned
indicates an access record, including a revoked one. The two states are separate.

## Security events and limitations

Successful post-commit events follow existing structured logging conventions:
member.account_provisioned, member.account_activated and member.gym_access_revoked.
They contain safe IDs, outcome and requestId, never email, credential, digest or
password. HTTP logging omits bodies/queries; credential fields are redacted.
Failed/rolled-back operations do not emit success events.

There is no email/SMS/WhatsApp delivery, OTP, password reset, email change,
reinvitation/resend, account recovery, auto-login or background worker. Losing an
activation credential or letting it expire does not permit repeat provisioning;
a future explicit recovery/reissue workflow is needed. Activation is possession
based and does not itself prove email ownership. Rate limits are per process;
multi-instance deployments need a shared store using the existing infrastructure.
GET is an operational view, not a transactional snapshot. Raw database writes
can bypass application invariants and are unsupported as a provisioning interface.

Tests use owned temporary MongoDB replica-set/standalone processes, never the
real .env or development/production data.
