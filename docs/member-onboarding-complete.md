> Scope update (2026-10-26): branch/attendance contracts in this milestone document are historical. [Current MuscleDesk scope, compatibility and gym-calendar policy](scope-cleanup.md) supersedes them; gym-level security and remaining workflows are preserved.

# Atomic member onboarding

`POST /api/v1/gyms/:gymId/member-onboarding/complete`

This separate endpoint creates a standalone active member profile, optionally a membership subscription and an initial manually recorded payment. It does not create login credentials, GymAccess, trainer assignments, attendance or other domain records. Existing member creation, onboarding, purchase, payment, renewal, cancellation and history endpoints retain their contracts.

## Authorization and headers

- `Authorization: Bearer <access token>` from the existing login flow.
- `Content-Type: application/json`.
- Required `Idempotency-Key`: 8–128 ASCII letters, digits, underscores or hyphens. A client-generated UUID is suitable. Generate one key per intended operation and persist it with the request until confirmation.
- Optional existing `X-Request-ID` for tracing. This is distinct from the durable idempotency key.

Only an authenticated active account with active **admin** GymAccess to the active URL-selected gym may use this endpoint. There is no additional owner role in the current model. Trainers and members are denied. The same checks apply to replays. Bootstrap access cannot bypass authentication.

## Member-only request

```json
{
  "member": {
    "memberCode": "ME01",
    "firstName": "Alex",
    "lastName": "River",
    "phone": "9876543210"
  }
}
```

`member` uses the existing onboarding schema: these four fields are required; optional branchId, dateOfBirth, gender, address and emergencyContact have the same validation and normalization. The server forces active status and derives gymId. Any branch must be active and belong to this gym. Clients cannot specify userId, gymId, status, role, ownership or internal fields. No new member fields are required.

## Member with membership and partial payment

```json
{
  "member": {
    "memberCode": "ME02",
    "firstName": "Alex",
    "lastName": "River",
    "phone": "9876543210"
  },
  "membership": {
    "planId": "111111111111111111111111",
    "payment": {
      "method": "cash",
      "amountPaise": 40000,
      "paidAt": "2026-01-01T10:00:00.000Z"
    }
  }
}
```

The planId above is illustrative; use an existing active plan in the authorized gym. Omit `membership` for member-only registration. Omit `membership.payment` for a subscription without an initial payment.

Optional `membership.startDate` uses the existing valid `YYYY-MM-DD` rules, with no future starts. When omitted it defaults to the current UTC date on the first successful attempt. Duration and exclusive end date come from the selected plan; historical periods may already be expired. No membership activation/date rules change.

When payment is provided, `method`, `amountPaise`, and `paidAt` are required, including when the amount is zero. Money is integer paise, 0–1,000,000,000. Supported methods remain cash, upi, bank_transfer, card and other. Positive upi/bank_transfer/card payments require `reference`, with the existing reference format and uniqueness rules. A zero amount creates no Payment record; its method and timestamp are still validated. Positive payments reuse existing recorder, reference and overpayment checks. Payments remain manual records, not gateway transactions.

All objects reject unknown fields. Payment without membership, supplied totals/balances and supplied subscription/payment identities are rejected. Discounts are **unsupported**: discount fields, including zero or negative discounts, are rejected with `400 VALIDATION_ERROR`. Partial payment never changes the subscription price. Adding discounts later requires an explicit persisted financial design and updates to all affected readers.

## Response

Successful first requests and exact replays return `201` and `Cache-Control: no-store`. Example for a 150000-paise plan with a 40000-paise payment:

```json
{
  "success": true,
  "data": {
    "operationId": "222222222222222222222222",
    "member": {
      "id": "333333333333333333333333",
      "gymId": "444444444444444444444444",
      "memberCode": "ME02",
      "firstName": "Alex",
      "lastName": "River",
      "status": "active"
    },
    "subscription": {
      "id": "555555555555555555555555",
      "membershipPlanId": "111111111111111111111111",
      "planNameSnapshot": "Monthly",
      "durationDaysSnapshot": 30,
      "pricePaiseSnapshot": 150000,
      "startDate": "2026-01-01",
      "endDate": "2026-01-31",
      "status": "active",
      "isCurrentlyActive": true
    },
    "payment": {
      "id": "666666666666666666666666",
      "subscriptionId": "555555555555555555555555",
      "amountPaise": 40000,
      "paymentMethod": "cash",
      "paidAt": "2026-01-01T10:00:00.000Z"
    },
    "billing": {
      "planPricePaise": 150000,
      "discountPaise": 0,
      "amountReceivedPaise": 40000,
      "outstandingBalancePaise": 110000
    }
  },
  "meta": { "requestId": "current-request-id" }
}
```

The dates and status illustrate the result at creation time. Member-only results have null subscription/payment and all-zero billing. Optional branchId/reference appear when applicable. Response summaries select fields from existing domain DTOs and omit unnecessary contact, account and internal information.

## Transactions, idempotency and recovery

Every new-endpoint workflow, including member-only, uses one MongoDB session/transaction with snapshot reads and majority writes. The existing member insert has a guarded shared-session entry point; existing subscription/payment shared-session entry points supply their business rules. No nested public transactions are used. Any member, subscription, payment, uniqueness, authorization or operation-record failure aborts all writes, including concurrency version writes.

The durable MemberOnboardingOperation stores a SHA-256 key digest, a digest of the validated/normalized request and a strictly shaped JSON result. A unique `(gymId, userId, keyDigest)` index is created additively during server startup, before listening. There is no in-memory cache or expiring TTL. Failed attempts leave no operation record and may be retried with the same key.

Real gym/access version writes serialize concurrent attempts and conflict with existing staff access changes. Transaction retries check for a previously committed operation before inserting domain records. Same key + equivalent normalized input returns the original saved result; different input returns `409 IDEMPOTENCY_KEY_CONFLICT`. Keys are independent across users and gyms. Explicit versus omitted dates are distinct inputs; replays of omitted dates retain the original resolved date.

After a timeout, lost response or post-commit confirmation failure, retry the original body with the **same key and authenticated user/gym**. Do not generate a new key. The replay returns the same `data.operationId` and result; `meta.requestId` describes the current HTTP request. There is no separate recovery/read endpoint. Saved subscription status and balances describe this operation at commit, not subsequent renewals, cancellation or payments; use existing reads for current state.

## Deployment requirements and limits

- MongoDB must support transactions (replica set or sharded deployment), including for member-only requests to this new endpoint. Standalone MongoDB returns `503 ONBOARDING_STORAGE_UNAVAILABLE`; there is no unsafe fallback. Legacy member-only onboarding still works without transactions.
- The application needs permission to add the required unique operation index. Existing records/indexes are preserved. No existing business-data migration or financial-reader change is required.
- Idempotency records are retained indefinitely for recovery. Any future archival/retention policy must explicitly define when key reuse becomes safe; silently expiring keys would permit repeated writes.
- Gym-wide serialization is a deliberate consistency tradeoff suited to the current small-team architecture; monitor contention as throughput grows.
- This operation does not provision a member login or activation credential. Use the existing separate member-account workflow where required.
- Tests use owned temporary local MongoDB processes, including a replica set, without loading `.env` or using development/production data.
