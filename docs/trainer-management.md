# Trainer Management — Milestone 10

TrainerProfile stores trainer domain data in one gym, independently of the login
identity in UserAccount. A standalone trainer does not require an account.
Creating or changing a profile never creates credentials, accounts or GymAccess.

## Schema and lifecycle

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference derived from authorized URL scope |
| trainerCode | Required immutable code, trimmed and uppercased; 2–32 characters |
| firstName / lastName | Required trimmed strings, 1–80 characters |
| phone | Required, maximum 25 characters; optional leading +, digits/spaces/parentheses/hyphens, 7–15 digits |
| status | Required; active by default, inactive or suspended |
| userId | Optional immutable UserAccount reference, trusted internal linking only |
| branchId | Optional mutable Branch reference, scoped to the same gym |
| dateOfBirth | Optional real YYYY-MM-DD calendar date, no future dates; stored at UTC midnight |
| gender | Optional female, male, non_binary, other or prefer_not_to_say |
| address | Optional object: required line1 (200), city (100), uppercase two-letter countryCode; optional line2 (200), state (100), postalCode (20) |
| specializations | Optional array of at most 10 trimmed, nonempty strings, each at most 80 characters; distinct ignoring case |
| createdAt / updatedAt | Server-managed timestamps |

Codes begin with A–Z or 0–9 and then use A–Z, 0–9, underscore or hyphen.
` tr001 ` normalizes to `TR001`. The unique `(gymId, trainerCode)` index
`trainer_gym_code_unique` allows the same code in different gyms and handles
concurrent creation. Inactive/suspended profiles retain their codes. Additional
indexes support gym and gym/status lists sorted by createdAt and _id. Startup
creates declared indexes additively, retaining unrelated indexes; conflicting
existing data fails startup rather than silently skipping uniqueness.

All three statuses may transition between one another. This is a trainer-domain
lifecycle, separate from account/access status. No account/grant changes or
cascading deletion occur. There is no DELETE endpoint.

## API and authorization

| Method | Endpoint | admin | trainer | member |
| --- | --- | --- | --- | --- |
| POST | /api/v1/gyms/:gymId/trainers | Allowed | Denied | Denied |
| GET | /api/v1/gyms/:gymId/trainers | Allowed | Denied | Denied |
| GET | /api/v1/gyms/:gymId/trainers/:trainerId | Allowed | Denied | Denied |
| PATCH | /api/v1/gyms/:gymId/trainers/:trainerId | Allowed | Denied | Denied |

Authentication, active GymAccess, active Gym and an explicit admin role are
required on every route. Services recheck persisted access and gym status rather
than accepting a stale authorization context. Each profile lookup/update uses
both trainerId and the authorized gymId; lists and counts use that same gym.
No trainer self-access or unauthenticated alternate route exists. These routes
also remain protected on the optional bootstrap listener.

Create example:

```json
{
  "trainerCode": "TR001",
  "firstName": "Alex",
  "lastName": "River",
  "phone": "+91 9876543210",
  "specializations": ["Strength", "Mobility"]
}
```

PATCH accepts only names, phone, branchId, dateOfBirth, gender, address,
specializations and status. Empty updates are rejected. Optional fields can be
cleared with null; arrays and nested address objects are replaced entirely.
Required fields cannot be removed. HTTP rejects gymId, trainerCode on PATCH,
userId, roles, access status, credentials, timestamps, MongoDB update operators
and all unknown fields. Model query updates strip immutable changes, while the
HTTP and service validation boundaries reject them explicitly.

Assigning a branch verifies it exists in the same gym and is active. Moving to
another active branch in that gym or removing a branch is supported. Updating
other fields does not require an unchanged branch to remain active.

Trusted internal callers may use the service's separate `linkedUserId` create
option, which validates an existing UserAccount. Controllers never forward HTTP
input into that option. This link confers no role or gym access and does not
require account activation; account provisioning/linking policy remains deferred.

Responses use the existing success/error envelope, requestId and no-store
headers. Explicit DTOs contain profile fields without account internals.
Validation is 400, unauthenticated access 401, role/access/inactive-gym denial
403, missing or foreign profiles 404 `TRAINER_NOT_FOUND`, missing or foreign
branches 404 `BRANCH_NOT_FOUND`, and duplicate code 409 `DUPLICATE_TRAINER_CODE`.
Unexpected database failures return sanitized 500 responses and no successful
authorization or write.

## Listing

Only page, limit, status and search are accepted:

- page: default 1, maximum 10000; limit: default 20, maximum 100.
- status: optional active, inactive or suspended.
- search: optional trimmed 1–100 character string. Case-insensitive literal
  substring matching covers trainerCode, firstName, lastName, phone and
  specializations. Regex metacharacters are escaped. Arbitrary filters and
  MongoDB operators are rejected.
- Sort: createdAt descending, then _id descending. The response list includes
  meta.pagination with page, limit, total. Controllers pass validated pagination
  to services, which validate again for trusted internal callers.

## Deferred work and limitations

No trainer/member assignments, self-access, workouts, schedules, payroll,
attendance, payments, memberships or onboarding were implemented.

Substring searches can scan gym records. Offset pagination and separate count
and list queries do not provide a snapshot during concurrent writes. Future
scale can justify indexed search and cursor pagination.

Gym/access/branch/account checks happen at query time without multi-document
transactions; a concurrent direct database change is not locked out. Future
branch lifecycle/deletion and linking workflows must address reference
consistency. Raw MongoDB writes bypass application rules and are not a supported
provisioning interface.

Integration tests use owned temporary MongoDB instances and generated test
credentials. They do not load .env or touch development/production databases.
