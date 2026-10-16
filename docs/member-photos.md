# Member profile photos

Photos are optional. Existing member, registration, membership and payment APIs
keep their existing payloads. Camera/gallery selection is staged privately on the
device and previewed before upload. Editing saves the photo separately from the
member's unsaved text fields. Onboarding uploads only after the original
registration is confirmed and has a member ID.

## Backend setup

In `/Users/semgroup/Desktop/BackendProjects/gym_management_backend/.env`, set all
three values from the Cloudinary Console's API Keys page:

```dotenv
CLOUDINARY_CLOUD_NAME=<your cloud name>
CLOUDINARY_API_KEY=<your API key>
CLOUDINARY_API_SECRET=<your API secret>
```

Use actual values locally, without angle brackets. Never put these values in
Flutter, Dart defines, screenshots, logs or Git. The backend `.env.example`
contains empty placeholders. Partial configuration is rejected at startup;
leaving all three empty allows the rest of the app to work and reports a safe
photo-storage-unavailable error for uploads. Restart the backend after setting
credentials (`npm start`, or restart `npm run dev`). MongoDB must support
transactions: use Atlas or a replica set, as for atomic member onboarding.

No unsigned Cloudinary upload preset or public upload endpoint is needed.
Cloudinary assets use authenticated delivery. The member record stores the
provider URL and public ID; Flutter receives a relative authenticated API photo
URL and revision. GET downloads use the existing bearer-token client and
single-flight token refresh. Credentials and provider IDs stay on the backend.

## API

All paths are relative to `/api/v1/` and require the existing gym access checks.

| Method | Path | Access / contract |
| --- | --- | --- |
| PUT | `gyms/:gymId/members/:memberId/photo` | Admin; multipart `photo`; UUIDv4 `Idempotency-Key` |
| DELETE | `gyms/:gymId/members/:memberId/photo` | Admin; UUIDv4 `Idempotency-Key` |
| GET | `gyms/:gymId/members/:memberId/photo/operations/:key` | Admin who owns the operation; verify uncertain outcome |
| GET | `gyms/:gymId/members/:memberId/photo?v=:revision` | Admin/trainer in the gym; JPEG bytes, no-store |

Only single-frame JPEG, PNG and WebP up to 5 MiB and 20 million decoded pixels
are accepted. The server checks the decoded format against the declared MIME,
re-encodes to JPEG, removes metadata, auto-orients, and resizes within 1600×1600.
The native picker requests the same dimensions and quality 82. iOS camera/photo
usage descriptions are in Info.plist. Android uses camera intents and the system
photo picker; broad storage permissions are not added.

## Recovery and cleanup

A private Application Support outbox is scoped by environment, API URL, account,
gym and member. Android lost-picker data is associated with its original scope.
A draft photo is linked to the existing registration idempotency keys before
submission and moved to the confirmed member without resubmitting registration
or payment. Confirmed registration can still be acknowledged if its optional
photo needs retry; Member Details exposes the retained operation.

An uncertain upload/removal retains its original key and checks server status
before retry. Replacing or cancelling an uncertain operation is blocked until
its outcome is resolved. Pre-upload selections can be replaced or cancelled.
Authenticated image downloads share a short-lived in-memory cache keyed by
member and revision, with a fixed-size initials fallback when missing or broken.

The backend stages each operation durably before upload. Member revision,
operation confirmation and old-asset cleanup enqueue commit in one MongoDB
transaction. The previous photo is kept through provider/database failures.
An immutable Cloudinary asset left by a lost response is resolved on retry.
A worker runs each minute: unused operations older than 24 hours are abandoned;
replaced/removed assets are deleted only when no member references them. Failed
deletions remain in the database and retry after five minutes. Run the normal
backend server for this worker; application-only test harnesses call it explicitly.

## Verification boundary

Backend tests use a real isolated MongoDB replica set and mocked Cloudinary;
SDK adapter tests also mock Cloudinary responses. These do not establish a
successful live upload. After configuring real credentials, verify gallery and
camera upload, app restart recovery, replacement, removal and authenticated
read against the running backend. A missing-provider configuration should leave
the saved selection recoverable and the previous member photo intact.

No Pay Now action is added to Outstanding Dues. Existing payment actions and
eligibility remain in Member Details.
