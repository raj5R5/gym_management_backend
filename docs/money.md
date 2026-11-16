# Phase 3a — receipts, expenses, profit and UPI

Owner decisions: receipts are **payment receipts, not tax invoices** (no GST
lines or GSTIN, even when a GSTIN is saved); receipts are shared as PDF built in
the app. Freeze and discounts are deferred to Phase 3b because they change the
immutable membership date/price rules.

All endpoints: authentication, active GymAccess with the `admin` role, active
gym, standard envelope, `Cache-Control: no-store`.

## `GET /api/v1/gyms/:gymId/payments/:paymentId/receipt`

Issues a receipt number on first request and returns the same number forever.
Numbers are per gym, increasing, formatted `R-00001` (a `GymCounter`
`{ gymId, key: 'receipt' }` with atomic `$inc`; `PaymentReceipt` unique on
`{ gymId, paymentId }` and `{ gymId, sequence }`). A lost concurrent race can
leave a gap in the sequence, never a duplicate. Indexes are created by the
service on first use.

Only `succeeded` payments: otherwise 409 `RECEIPT_UNAVAILABLE`; unknown payment
404 `PAYMENT_NOT_FOUND`.

Response: `receiptNumber`, `issuedAt`, `timezone`,
`gym { name, phone, email, address }`, `member { id, memberCode, name, phone }`,
`payment { id, amountPaise, method, reference, paidAt }`,
`membership { planName, startDate, endDate (exclusive), pricePaise, paidTotalPaise, balancePaise, cancelled }`.
Membership totals are as of the request, not as of the payment.

## Expenses — `/api/v1/gyms/:gymId/expenses`

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Query `from`, `to` (inclusive gym-local dates; default the current gym month), `category`, `page`, `limit`. Returns `{ from, to, totalPaise, byCategory, data, pagination }` |
| POST | `/` | Strict `{ category, amountPaise, spentOn, paymentMethod?, note? }`; future dates (gym-local) are rejected |
| DELETE | `/:expenseId` | Soft removal (`status: removed`, who and when are kept); 404 `EXPENSE_NOT_FOUND` if already removed |

Categories: rent, salaries, electricity, equipment, maintenance, marketing,
supplies, other. Amounts are integer paise. Records are otherwise immutable.

## Dashboard

`expenses: { periodAmountPaise, profitPaise }` for the selected period.
`profitPaise` = successful payments collected minus active expenses in the
period; it can be negative (a loss).

## Gym settings

`upiId` (VPA, stored lower-case) and `upiPayeeName`, both nullable. The app
builds `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…` QR codes from them. Nothing is
recorded automatically: the owner confirms receipt and records the payment with
its UTR.
