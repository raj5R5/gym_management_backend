# MuscleDesk: scope and Android release candidate

Attendance and branch management/assignment are retired. Members, trainers,
trainer/member assignments, plans, memberships, payments, dues, revenue, owner
profiles and privacy remain. Keep GymAccess, gymId isolation, roles and Iron Signal.

## Contracts and historical data

Flutter accepts old responses with attendance/currentBranch sections and new
responses without them. No attendance zeros are fabricated. Legacy report branch
markers are used only to reject narrowed old-server results. New branch filters
are rejected, never silently ignored to return broader financial results.

The backend removes active routes/model registration, not database records/indexes.
Ordinary profile writes reject branch assignment; other edits preserve historical
branch IDs without lookups. Legacy onboarding frozen bodies, keys, digests and
immutable receipts remain valid. Optional legacy branchId in complete-onboarding
is opaque metadata retained in the digest/receipt, never a live assignment.
Do not rewrite unresolved requests, clear their ledgers or substitute new keys.
Old installed clients still require retired fields: coordinate their update before
deploying the new API. Deployment is separate from these local changes.

## Gym calendar policy

Membership defaults, future-start validation, expiry, renewal and summaries use the
gym's configured IANA timezone, consistently with Dashboard status. Missing settings
retain UTC fallback; invalid zones fail closed. Stored dates remain canonical
UTC-midnight calendar labels. Exclusive ends, duration days, plan snapshots and
money rules remain unchanged. Payment timestamps remain UTC instants and reporting
uses gym-local boundaries. No database timezone or stored membership was migrated.
Gyms without timezone configuration need an explicit setting, not phone inference.

## Account deletion: request intake only

Owners receive confirmation that their secure request was received, not completed.
No account, financial, payment, membership transaction or audit record is deleted
or altered automatically. Requests require manual review of legitimate retention,
authorization and ownership transfer for shared gyms before any removal. No fixed
retention period or claim of legal compliance is approved. Historical retained
attendance/branch data must remain in privacy/deletion review. An accountable,
verified fulfillment process remains outstanding before public launch.

## Release blockers

- Permanent Play application ID, private upload signing and Console identity are
  unconfirmed. Do not invent keys/IDs or weaken release guards.
- Publisher, support email and public privacy/deletion URLs need owner input.
- Password recovery lacks configured delivery/reset infrastructure. An email-only
  reset is not an acceptable substitute.
- Backend changes are local; approved deployment and compatibility checks remain.
- Signed AAB, certificate, 16KB compatibility, store disclosures, production
  operations and Play-delivered installs still need verification.
- iOS needs final identity/icon, public-link native support, pod reproducibility,
  privacy-manifest review and signed-device verification.

A debug APK and automated tests do not certify readiness for public publication.
