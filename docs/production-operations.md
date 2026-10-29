# Production operations and account deletion

Local code preparation does not deploy changes to the Hostinger VPS. Do not run destructive operations against the hosted database for validation. The existing HTTPS API remains authoritative for membership eligibility, expiry, money and permissions.

## VPS configuration

The backend now supports optional `API_BIND_HOST` and `TRUSTED_PROXIES` (exact IP addresses/CIDRs, never `true`, `*`, hostnames or `/0`). Defaults preserve existing binding and disabled proxy trust. For a verified same-host Nginx topology, privately bind Node to `127.0.0.1` and trust only the actual proxy source, e.g. `127.0.0.1/32,::1/128`; confirm firewall/listener rules before applying. Nginx must overwrite forwarding headers and must not expose bootstrap routes/port. Otherwise proxy IP rate limits can unintentionally group all gym owners together. Multi-instance deployment needs shared rate-limit storage or coordinated proxy limits; current in-process limits are not a distributed limiter.

Use `NODE_ENV=production`, bootstrap disabled, actual secret environment configuration, TLS, transactional MongoDB, authentication/authorization and existing unique indexes. Never put JWT/Cloudinary/database credentials in Flutter. Restart through the existing service manager only after approved deployment. New deletion indexes are created during normal startup before listening; no indexes are dropped.

## Account-deletion intake — implemented locally

- Authenticated `GET /api/v1/auth/account-deletion-request` returns `{request: null}` or the current user's receipt.
- Authenticated `POST` at that path accepts only `{currentPassword, acknowledgement: "REQUEST_ACCOUNT_DELETION"}` and returns HTTP 202 with a receipt. Current password is reverified. It takes no user/gym ID or requested status from the client.
- External `GET /account-deletion` serves a script-free HTML form. POST accepts email/current password/acknowledgement, verifies the existing hash and records the same account-scoped request without requiring the installed app or creating a session. Inactive accounts can request externally. Unknown account/wrong password share the same error; attempts are rate-limited. Passwords are never placed in URLs or stored in the request.
- Unique account index and atomic upsert make duplicates/concurrent retries return one receipt. Status reads are scoped and no-store. Request fields contain only account reference, status and timestamps. It does not alter memberships, financial records, photos, sessions, account status or gym access.
- The app rechecks status after an ambiguous POST. No success is shown without a server receipt; a received request never claims completed deletion. Old deployed APIs present an explicit unavailable/retry state.

## Manual deletion fulfillment — release process

Approved 29 October 2026: Raj reviews and fulfils deletion requests personally. Users request deletion in the app (`POST /api/v1/auth/account-deletion-request`), on `/account-deletion`, or by email to the support address. Requests show `requested` → `in_review` → `completed`, and `completed` is set only by the worker after erasure is verified.

Server configuration (`.env`, never committed): `ACCOUNT_DELETION_AUTOMATION=operator`, `ACCOUNT_DELETION_NOTICE_KEY` (`openssl rand -hex 32`) and the three `RECOVERY_SMTP_*`/`RECOVERY_EMAIL_FROM` values. Startup refuses operator mode without them. Operator mode keeps the intake routes, adds no self-service routes, starts the deletion worker after listen, and emails alerts to `RECOVERY_EMAIL_FROM` instead of the requester.

Operator procedure, on the server (`npm run deletion:operator -- <command>`):

1. `list` — open requests with account email and job state.
2. Email requests: reply to the account's address; after the reply from that mailbox, `record-email <address>` creates the request.
3. `show <requestId>` — account, gyms, allowed choices and successors.
4. Sole-owned gyms: email the owner. For a handoff, the owner promotes the staff member to admin in Staff, then the gym is `leave`. For closure, keep the owner's written confirmation and pass `--closure-confirmed`.
5. `fulfill <requestId> <gymId>=leave|close … --yes [--closure-confirmed]` (without `--yes` it is a dry run). The API worker then erases the account in one transaction, purges closed gyms (resumable), drains Cloudinary photo cleanup, verifies the live database and sends the completion email.
6. `status <requestId>` — job stage. A stopped job (`needs_action`) erased nothing; resolve the reason and run `fulfill` again.

After any database restore, re-run fulfilment for requests whose `AccountDeletionRequest` is `completed` before reopening the service (the request and job records keep only ids and timestamps for this).

Optional `ACCOUNT_DELETION_AUTOMATION=enabled` instead exposes self-service review/confirmation (code in `src/modules/accountDeletion/automation.*`, routes `/api/v1/auth/account-deletion/*`); it is not used for the first release.

## Reliability verification

1. Configure encrypted, access-controlled scheduled MongoDB backups and retention. Store a recovery copy separately from the VPS; monitor failures. Cloudinary images and database references need a compatible recovery/deletion strategy.
2. Restore a backup into a separate isolated environment. Verify member counts, plan terms, fees/dues/history, user/gym isolation and representative protected photos. Record restore duration and evidence; backup existence alone is insufficient.
3. Reconcile a synthetic gym through full/partial payments, expired memberships with dues, renewals/cancellation, duplicate references, interrupted/uncertain writes, device restart and session renewal. Never use production payments for smoke tests.
4. Monitor process/database readiness, safe error/latency metrics, disk/certificate capacity, photo cleanup failures and deletion-request age. `/health` is liveness; `/ready` is database/application readiness. Protect operational access and avoid logging personal/request bodies or credentials.
5. Test the actual release install/update path, secure-storage/outbox retention and Android process death. Test low-end hardware, poor network and a 16 KB emulator/device; include photo permission failures, accessibility and keyboard clearance.

No backup schedule, restore exercise, VPS configuration, production deployment, monitoring service or data deletion has been performed by these local code changes.

## Approved deletion-intake policy

Requests acknowledge receipt only and require manual review. No automatic account/financial/audit deletion or fixed retention period is approved. Legitimate retention, shared-gym ownership transfer and verified fulfillment remain operational requirements before public launch. See [current policy](scope-cleanup.md).
