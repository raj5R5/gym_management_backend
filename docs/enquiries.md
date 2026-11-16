# Phase 4 — enquiries, trials, referrals and birthdays

Owner rules: trials last **3 days**; referrals are **tracked only** (no automatic
reward); converting an enquiry opens Add member pre-filled in the app and then
links the new member to the enquiry.

All endpoints: authentication, active GymAccess with the `admin` role, active
gym, standard envelope, `Cache-Control: no-store`. Dates are gym-local calendar
days stored as UTC-midnight labels.

## Enquiries — `/api/v1/gyms/:gymId/leads`

Stored in the `Lead` collection. Pipeline: `new` → `contacted` → `trial` →
`joined`, or `lost` (with a reason; can be reopened). `joined` is final.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Query `status` (a status or `open`), `followUp=due` (open, follow-up today or earlier, soonest first), `referredByMemberId`, `search` (name, or 3+ phone digits), `page`, `limit`. Returns `counts` per status plus `open` and `followUpsDue` |
| POST | `/` | `{ firstName, lastName?, phone, source?, referredByMemberId?, interestedPlanId?, nextFollowUpOn?, note? }`. The first follow-up defaults to today; a referrer sets the source to `referral` |
| GET | `/referrals` | Top 50 referrers: `{ member, referred, joined }` |
| GET | `/:leadId` | One enquiry with notes (newest first) |
| PATCH | `/:leadId` | Name, phone, source, `status` (`new`, `contacted`, `lost` only), `lostReason` (required for `lost`), `nextFollowUpOn`, referrer, interested plan; `null` clears optional fields |
| POST | `/:leadId/notes` | `{ text }` (at most 200 notes) |
| POST | `/:leadId/trial` | `{ startDate? }` (today or later): trial `[start, start+3)`, follow-up on the last trial day |
| POST | `/:leadId/convert` | `{ memberId }`: marks `joined` and links the member. Repeating with the same member is a no-op; another member is 409 |

Errors: 404 `LEAD_NOT_FOUND`; 409 `DUPLICATE_LEAD` (an open enquiry already has
this phone number; `details.leadId` points at it); 409 `LEAD_STATE_CHANGED`
(state moved meanwhile, or the enquiry has joined); 404 `MEMBER_NOT_FOUND` /
`PLAN_NOT_FOUND` for references outside the gym. Writes are conditional on the
current status. The service creates the collection's indexes on first create.

## Birthdays — `GET /api/v1/gyms/:gymId/member-overview/birthdays?days=7`

Active members with a date of birth whose next birthday is within `days`
(0–30) gym-local days, soonest first: `{ member, daysUntil, turning, date }`.
Feb 29 birthdays are celebrated on Feb 28 in non-leap years.

## Dashboard

`leads: { newInPeriod, joinedInPeriod, followUpsDue, activeTrials }` —
enquiries created and converted in the selected period, plus current counts.
