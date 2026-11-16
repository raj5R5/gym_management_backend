# Phase 3b — membership freeze and discounts

Owner rules: plans of **90+ days** can be frozen, at most **30 frozen days in
total per membership** (any number of freezes), freezes start **today or later**
(gym-local), and discounts are entered as an amount or a percent and can never
exceed what is still unpaid.

## Data model changes

`MemberSubscription` gains `frozenDays` and `discountPaise` (both default 0;
older records without them are treated as 0). The invariants become:

- `endDate = startDate + durationDaysSnapshot + frozenDays`
- list price = `pricePaiseSnapshot + discountPaise`; `pricePaiseSnapshot` is what is owed.

`endDate`, `frozenDays`, `pricePaiseSnapshot` and `discountPaise` still behave as
immutable for ordinary query updates: a schema hook strips them unless the
update carries the `membershipAdjustment: true` option, which only the
adjustment service sets. Because dues, expiry, renewals, the dashboard and the
member overview already read these fields, they follow freezes and discounts
without further changes.

Audit records: `MembershipFreeze` (`startDate`, exclusive `endDate`, `days`,
`status`, optional `reason`, who/when ended early) and `MembershipDiscount`
(`amountPaise`, optional entered `percent`, optional `reason`; immutable).

## API — `/api/v1/gyms/:gymId/subscriptions/:subscriptionId/adjustments`

Admin only, gym-scoped, `Cache-Control: no-store`. Every write runs in a
transaction with an optimistic check on the subscription's current end date,
price and counters (409 `ADJUSTMENT_CONFLICT` if it changed meanwhile).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Prices, balance, freeze rules applied (`freeze.allowed`, `blocker`, `daysLeft`, start range), freezes and discounts |
| POST | `/freezes` | `{ startDate, days, reason? }` |
| POST | `/freezes/:freezeId/end` | End a current freeze today, or cancel an upcoming one; unused days return |
| POST | `/discounts` | `{ amountPaise }` or `{ percent }` (of the list price, rounded to the paisa), `reason?` |

Freeze refusals: 409 `FREEZE_NOT_ALLOWED` with `details.blocker` one of
`cancelled`, `plan_too_short`, `ended`, `renewal_queued` (a later membership
already starts when this one ends), `no_days_left`, `start_out_of_range`,
`too_many_days` (with `daysLeft`), `freeze_finished`, `later_freeze` (end the
later freeze first); 409 `FREEZE_OVERLAP`. Zero-day records (freezes cancelled
before they began) never count as overlaps.

Discount refusals: 409 `DISCOUNT_EXCEEDS_BALANCE` (`details.balancePaise`),
409 `SUBSCRIPTION_CANCELLED`. A discount is not a refund: money already paid is
never reduced.

## Effects elsewhere

- Member overview: `membership.frozenUntil` when a freeze covers today; frozen
  members are excluded from the `inactive` (not visiting) filter.
- Check-in: a frozen membership is refused with `membershipState: 'frozen'` and
  `frozenUntil`, unless `override: true`; overridden visits record `frozen`.
- Member summary: memberships report `frozenDays` and `discountPaise`.
- Receipts: `membership.listPricePaise` and `membership.discountPaise`.
