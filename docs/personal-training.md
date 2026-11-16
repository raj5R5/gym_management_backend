# Phase 5b — personal training (PT) packages and trainer commission

Owner rules: a PT package is N sessions with one trainer for one member at a
price. Each trainer has a commission percent (default 0). A package keeps the
rate it was sold at; changing the rate affects only packages sold afterwards.
Commission accrues on PT money **collected**, so it follows payments, not
sessions. Branches stay separate: everything is per gym.

Base path `/api/v1/gyms/:gymId/pt`. Authentication, active GymAccess, active gym,
standard envelope, `Cache-Control: no-store`. Dates are gym-local calendar days.

| Method | Path | Roles | Purpose |
| --- | --- | --- | --- |
| GET | `/packages` | admin, trainer | Query `memberId`, `trainerId`, `status` (`active`, `completed`, `cancelled`), `page`, `limit` |
| POST | `/packages` | admin | `{ memberId, trainerId, name?, sessions, pricePaise, startDate?, validDays?, payment? }`. Start is today or later; `validDays` sets `expiresOn` (exclusive). Links the trainer to the member if not already assigned |
| GET | `/packages/:packageId` | admin, trainer | Package with the latest 100 sessions; admins also get payments |
| POST | `/packages/:packageId/payments` | admin | `{ amountPaise, method?, reference? }`; at most the unpaid balance |
| POST | `/packages/:packageId/sessions` | admin, trainer | `{ sessionDate?, note? }`; between the start and today, before expiry. The last session completes the package |
| POST | `/packages/:packageId/cancel` | admin | Active packages only; payments stay on record |
| GET | `/rates` | admin | Active trainers with their commission percent |
| PUT | `/rates/:trainerId` | admin | `{ percent }` (0–100, two decimals) |
| GET | `/commissions` | admin | `preset` (`today`, `last7Days`, `thisMonth`, default) or `from`/`to`. Per trainer: collected, commission, payments, sessions; plus totals |

Trainers see only packages of their own (single, active) trainer profile, and
never see prices, payments or commission. A trainer filter for another trainer
is 403; another trainer's package is 404.

Errors: 404 `PT_PACKAGE_NOT_FOUND`, `MEMBER_NOT_FOUND`, `TRAINER_NOT_FOUND`;
409 `PT_PACKAGE_CLOSED`, `PT_PACKAGE_EXPIRED`, `PT_PAYMENT_EXCEEDS_BALANCE`,
`PT_PARTICIPANT_INACTIVE`; 400 `PT_SESSION_DATE_INVALID`. Payment totals and
session counts change only through conditional increments, so concurrent
requests cannot overpay or overbook. Commission is `round(amount × percent / 100)`
in paise, stored on each payment.
