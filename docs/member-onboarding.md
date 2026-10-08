# Member onboarding — Milestone 21

`POST /api/v1/gyms/:gymId/member-onboarding` registers one person as a member of
an authorized gym. It creates exactly one existing MemberProfile document.
Onboarding is not account provisioning, subscription creation, payment recording
or trainer assignment; none of those operations happen automatically.

## Authorization

Existing authentication, active account/session, active GymAccess, active Gym
and explicit admin/trainer role are required. Members are denied. Services
independently recheck gym-scoped access before writing. A trainer performs a staff
registration operation and needs neither an existing TrainerProfile nor a
TrainerMemberAssignment. They cannot select another unauthorized gym, provision
staff, assign roles or mutate access through this endpoint. Bootstrap listener
restrictions and existing member CRUD authorization are unchanged.

## Request

```json
{
  "memberCode": " gym001 ",
  "firstName": "Alex",
  "lastName": "River",
  "phone": "+91 9876543210",
  "branchId": "<optional same-gym active branch ObjectId>",
  "dateOfBirth": "1995-06-12",
  "gender": "prefer_not_to_say",
  "address": { "line1": "Home Road", "city": "City", "countryCode": "IN" },
  "emergencyContact": { "name": "Pat", "phone": "9876543211", "relationship": "Sibling" }
}
```

Required fields are memberCode, firstName, lastName and phone. All others shown
are optional. Omit branchId to leave the member unassigned to a branch; no branch
is selected automatically, and null/invalid identifiers are rejected. Optional
birth date, gender, address and emergency contact preserve existing member-domain
nullable validation; null values are omitted from the inserted record.

Validation is derived from existing strict member rules: member codes are
trimmed, uppercased, 2–32 characters and contain permitted letters/digits/underscore
or hyphen; names are trimmed 1–80 characters; phone is at most 25 characters with
7–15 digits and permitted formatting. Birth dates are real YYYY-MM-DD dates,
not future dates. Gender, address and emergency contact use the existing enums,
nested field allowlists, limits and phone rules. Unknown/protected fields and
MongoDB objects/operators are rejected.

The body cannot set gymId, userId, status, normalized fields, internal IDs,
credentials, timestamps, subscriptions, plans, payment data, trainers, roles or
permissions. The server derives gymId from trusted authorization context and
always inserts status=active. No login account is created or linked.

## Member identity and branch checks

Canonical uniqueness is gymId + normalized memberCode, enforced by the existing
unique index, including concurrent requests. Duplicate requests return the normal
409 DUPLICATE_MEMBER_CODE envelope without merging, reusing or updating the
existing member. Member codes remain immutable under existing management rules.
The same code in different authorized gyms is valid. Shared phone numbers are
allowed; no phone uniqueness or duplicate-person heuristic is introduced.

A supplied branch is looked up within the authorized gym and must be active.
Missing/foreign branches produce BRANCH_NOT_FOUND (404); inactive branches produce
FORBIDDEN (403). The response uses the existing branchId convention, rather than
adding branch name/contact data or a second lookup. It exposes only the verified
reference and cannot accidentally join another gym's branch display information.
No additional per-record lookups, indexes or models are added.

## Response

201 with the existing success envelope and member DTO:

```json
{
  "success": true,
  "data": {
    "id": "<memberId>",
    "gymId": "<authorizedGymId>",
    "branchId": "<branchId when supplied>",
    "memberCode": "GYM001",
    "firstName": "Alex",
    "lastName": "River",
    "phone": "+91 9876543210",
    "status": "active",
    "createdAt": "<UTC timestamp>",
    "updatedAt": "<UTC timestamp>"
  },
  "meta": { "requestId": "<requestId>" }
}
```

Supplied dateOfBirth, gender, address and emergencyContact are also included.
Absent optional fields, including userId, are omitted. Responses use
Cache-Control: no-store and explicit existing DTO fields; no credentials,
sessions, tokens or Mongo internals are returned. Client errors and database
failures use existing sanitized centralized error handling.

## Implementation and limits

The endpoint lives in the existing member module. It shares validation fields,
normalization, branch validation, the insertion helper and DTO with existing
member management. Existing POST remains admin-only, existing PATCH stays
admin-only, and existing read policies/status management remain unchanged.

One atomic MemberProfile insert is performed, with no transaction requirement.
It works on standalone MongoDB and depends on the existing unique index installed
by startup. No account, GymAccess, subscription, payment, attendance or assignment
writes, notifications, OTP, verification, invoices or background jobs occur.

Authorization and branch checks reflect database state at lookup time, not a
cross-document transaction snapshot. Concurrent administrative changes or
unsupported raw branch deletion after validation are not locked; later branch
status/ownership display must be resolved by the existing scoped read workflows.
No historical branch display snapshot or request idempotency key is introduced.
A duplicate retry receives conflict; it does not silently return the original
record. Tests use owned isolated MongoDB and never real .env/database credentials.
