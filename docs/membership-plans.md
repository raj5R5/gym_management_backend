# Membership Plans — Milestone 12

MembershipPlan is a reusable gym product. It contains no member, subscription,
subscription dates, payment records or payment calculations. Future subscriptions
can reference it, including historical references to inactive plans.

## Schema and money

| Field | Contract |
| --- | --- |
| gymId | Required immutable Gym reference derived from authorized URL scope |
| name | Required normalized display name, 1–120 characters |
| normalizedName | Server-derived lowercase uniqueness key, hidden from API DTOs |
| durationDays | Required integer, 1–3650 days |
| price | Required integer INR paise, 0–1,000,000,000 inclusive |
| status | active (default) or inactive |
| description | Optional trimmed nonempty text, maximum 2000 characters |
| createdAt / updatedAt | Server-managed timestamps |

INR is the v1 assumption, consistent with the milestone's rupee examples.
There is no currency field or multi-currency support. **Every API price is in
paise**, on input and output: ₹1500 is `150000`; ₹4000 is `400000`.
Zero-priced plans are allowed. The maximum is ₹10,000,000 (one crore).
MongoDB stores price as a Mongoose Number constrained to exact safe integers;
the bounded values are represented exactly. The backend performs no rupee
conversion, floating-point money arithmetic, tax, discount or payment calculation.
Fractional minor units, numeric strings, negatives, NaN, Infinity and over-limit
values are rejected. Clients must supply an integer quantity of paise.

Names undergo Unicode NFKC normalization, whitespace collapse and trimming while
preserving display case. The derived key is lowercase. `Monthly`, ` monthly `,
`MONTHLY` and full-width `Ｍonthly` share a uniqueness key. Lowercasing is
locale-independent; this is not accent-insensitive matching.

The unique `(gymId, normalizedName)` index `plan_gym_name_unique` prevents
concurrent duplicates within a gym and permits the same name in other gyms.
Inactive plans retain their names. Renaming recalculates the key server-side,
releasing the old name; conflicting renames fail atomically with 409.
Gym and gym/status indexes support creation-time lists. Startup adds indexes
without dropping unrelated indexes and fails if conflicting data prevents creation.

## API and authorization

| Method | Endpoint | admin | trainer | member |
| --- | --- | --- | --- | --- |
| POST | /api/v1/gyms/:gymId/membership-plans | Create | Denied | Denied |
| GET | /api/v1/gyms/:gymId/membership-plans | List | List | Denied |
| GET | /api/v1/gyms/:gymId/membership-plans/:planId | Read | Read | Denied |
| PATCH | /api/v1/gyms/:gymId/membership-plans/:planId | Update | Denied | Denied |

Existing authentication, active GymAccess, active Gym and explicit role guards
are required. Services recheck current persisted gym access and role. Resource
queries include both the plan ID and authorized gym; list/count queries share
the same gym filter. Routes remain protected on the optional bootstrap listener.

Create example:

```json
{
  "name": "Monthly",
  "durationDays": 30,
  "price": 150000,
  "status": "active"
}
```

PATCH accepts only name, durationDays, price, status and description. Empty
updates are rejected. Omitted fields are preserved; null clears only description.
Plan ID and gym cannot change. Client-supplied normalizedName, identity/role
fields, timestamps, currency, subscription/payment fields, MongoDB operators and
all other unknown fields are rejected. Mongoose query updates strip immutable
gym changes; HTTP and service validation reject them explicitly.

Responses use existing success/error envelopes, requestId, explicit DTOs and
no-store headers. Validation returns 400, unauthenticated access 401, authorization
denial 403, missing/foreign plans 404 `PLAN_NOT_FOUND`, and duplicate names 409
`DUPLICATE_PLAN_NAME`. Database failures return safe 500 responses.

## Lifecycle and listing

Admins can transition active/inactive in either direction. Repeated deactivation
is safe and retains the record; updatedAt follows ordinary update semantics.
There is no DELETE route. Both allowed staff roles can inspect inactive plans.
A future subscription policy must reject new selection of inactive plans unless
explicitly approved otherwise. That selection logic is not implemented here.

Only page, limit, status and search query parameters are accepted:

- page defaults to 1, maximum 10000; limit defaults to 20, maximum 100.
- status is optional active/inactive.
- search is trimmed, 1–100 characters, matched as a case-insensitive literal
  substring of the display name. Regex metacharacters are escaped; description
  search is not implemented. Operators, duplicate parameter arrays and arbitrary
  filters are rejected.
- Sort is createdAt descending then _id descending. meta.pagination includes
  page, limit and total beside requestId.

## Deferred work and limitations

No subscriptions, member self-access, payments, discounts, GST/taxes, coupons,
currency conversion or billing calculations were added. Future subscriptions
should define snapshots/versioning for price, duration and plan-name changes;
current plan edits do not promise immutable historical subscription terms.

Authorization checks observe database state at lookup time without a multi-document
transaction. Uniqueness is enforced atomically by MongoDB. Raw database writes
bypass application rules and are not a supported provisioning interface.
Substring search can scan gym records, and offset pages plus separate list/count
reads are not a snapshot under concurrent writes. Optimize after measuring scale.

Integration tests run against owned temporary MongoDB instances, never the real
.env or development/production databases.
