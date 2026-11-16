# Phase 6 — member app: access, home and UPI payments

Owner rules: members get in with a one-time **activation code** the owner sends
by WhatsApp (the owner never knows the password). Members pay dues by UPI from
the app; a payment counts only after the **owner confirms** it.

## Access (extends [member-account.md](member-account.md))

- Activation codes now last **72 hours** (was 15 minutes) so they can be sent by
  WhatsApp. They stay single-use and are stored only as a SHA-256 digest.
- `POST /api/v1/gyms/:gymId/members/:memberId/account/reissue` (admin): a new
  code for a member who has access but has not set a password. Earlier unused
  codes stop working. 404 `MEMBER_ACCOUNT_NOT_PROVISIONED`, 409
  `MEMBER_ACCOUNT_ALREADY_ACTIVATED`.

## Member home — `/api/v1/me/gyms/:gymId` (role `member`)

The member is resolved from the signed-in account (same resolver as
[member-self-service.md](member-self-service.md)); no member id is accepted.

| Method | Path | Data |
| --- | --- | --- |
| GET | `/home` | `today`, `gym` (name, phone, address, `upiId`, `upiPayeeName`), `member`, `membership` (state, plan, dates, `daysLeft`, `expiringSoon`, `renewedAhead`, `frozenUntil`), `dues` (`balancePaise`, `dueSubscriptionId`, `pendingClaimPaise`), `visits` (`thisMonth`, `lastVisitDate`, `visitedToday`, `weekStreak`, `recent`), `pt` (active packages: sessions, trainer name, balance; never commission) |
| GET | `/payments/:paymentId/receipt` | The member's own receipt (same data as the staff receipt). Another member's payment is 404 `PAYMENT_NOT_FOUND` |

`weekStreak` counts consecutive Monday-start weeks with a visit, ending this
week, or last week if there is no visit yet this week.

## UPI payment reports — `PaymentClaim`

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/me/gyms/:gymId/payment-claims` | member | `{ amountPaise, reference }` with the 12-digit UPI transaction ID. Applies to the oldest unpaid membership; at most its balance minus other pending reports |
| GET | `/api/v1/me/gyms/:gymId/payment-claims` | member | Latest 10 reports with status |
| GET | `/api/v1/gyms/:gymId/payment-claims?status=pending` | admin | Reports with member and plan (pending oldest first) |
| POST | `/api/v1/gyms/:gymId/payment-claims/:claimId/confirm` | admin | In one transaction: marks it confirmed and records a real `upi` Payment through the payment service (overpayment, cancelled membership and duplicate-reference rules apply; on any failure the report stays pending) |
| POST | `/api/v1/gyms/:gymId/payment-claims/:claimId/reject` | admin | `{ reason }` shown to the member |

A UTR can have only one live (pending or confirmed) report per gym; a rejected
one can be reported again. Errors: 409 `CLAIM_EXCEEDS_DUE`,
`DUPLICATE_CLAIM_REFERENCE`, `CLAIM_ALREADY_DECIDED`; 404 `CLAIM_NOT_FOUND`.
The service creates the collection's indexes on first report.
