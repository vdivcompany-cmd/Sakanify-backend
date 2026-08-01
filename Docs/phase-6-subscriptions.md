# Phase 6 — Owner Subscriptions & Bed Capacity (+ Optional Utility Bill Splitting)

## Goal
Track each Owner's subscription tier (allowed bed/building capacity) and support requests to expand it. Also add an **optional** utility bill-splitting feature for buildings where the owner does not include electricity/water/natural gas in the monthly rent.

## Context
Sakanify's business model is tiered by bed capacity (e.g., "50-bed package" at a set monthly price). This module tracks current tier and usage, and the request pathway for expansion, which Phase 7 (Super-Admin) approves or rejects.

Separately, in Sohag most landlords either bundle utilities into rent or split them among the apartment's students. This phase adds that as an **opt-in** feature — buildings default to "utilities included in rent" (current behavior, unchanged) unless the owner explicitly turns splitting on for that building.

## Folders & Files to Create This Phase

```
src/modules/subscriptions/
├── subscription.routes        → Get current subscription/usage, request expansion
├── subscription.controller
├── subscription.service         → Usage calculation, threshold warnings, expansion request creation
└── subscription.model            → owner reference, tier/package name, total bed capacity, monthly price, status (active/overdue/suspended), renewal date

src/modules/utilities/
├── utility-bill.routes         → Submit a bill for an apartment, list bills per apartment/building
├── utility-bill.controller
├── utility-bill.service         → Split calculation, attaching shares to the matching Payment records, rounding logic
└── utility-bill.model            → apartment reference, building/owner_id (denormalized), bill_type (electricity/water/gas), billing_period, total_amount, split (array of {student, rental, payment, share_amount}), entered_by, entered_at
```

## Implementation Steps — Subscriptions (Original Scope)

1. Build `subscription.model` with the fields above.
2. Build usage calculation logic in `subscription.service`, comparing actual bed count (from Phase 3's `bed.service`) against the subscription's allowed capacity.
3. Build a warning threshold (e.g., 90%+ utilized) to surface as a dashboard alert later.
4. Build the "Request Bed Expansion" endpoint: creates a record consumed by the Super-Admin expansion queue (Phase 7).
5. Build subscription status transitions (active/overdue/suspended) and the business rules tied to each (e.g., a suspended owner may be blocked from accepting new requests).
6. Ensure all subscription data is scoped via the Phase 1 ownership helper — an owner only ever sees their own subscription.

## Implementation Steps — Optional Utility Bill Splitting (New This Phase)

7. **Retrofit `building.model` (Phase 3)**: add `utilities_included_in_rent` (boolean, **default `true`**) — this preserves current behavior for every existing building unless the owner explicitly opts in to splitting. Build an owner-facing endpoint to toggle this setting per building.

8. **Retrofit `payment.model` (Phase 5)**: add two fields — `rent_amount` and `utility_amount` — where `amount_due = rent_amount + utility_amount`. For existing payment records, migrate `rent_amount = amount_due` and `utility_amount = 0` (non-breaking default). Update `payment.service`'s creation logic (initial payment + rollover) to set `rent_amount = rental.monthly_rent` and `utility_amount = 0` by default.

9. Build `utility-bill.model` and `utility-bill.service`. When an owner submits a bill for an apartment (`bill_type`, `billing_period`, `total_amount`):
   - Reject if `building.utilities_included_in_rent === true` for that apartment's building (utilities are already bundled — splitting doesn't apply).
   - Fetch the apartment's **currently active** rentals (call into `rental.service`, do not query the Rentals collection directly — same cross-module rule as always).
   - Reject if there are zero active rentals in the apartment (nothing to split among).
   - Split `total_amount` equally among the active students: divide, round each share to 2 decimal places, and assign any rounding remainder to the **last** student in the split so the shares sum exactly to `total_amount`.
   - For each student, find (or create, via `paymentService.ensurePaymentForPeriod()`, reusing Phase 5's creation logic) that student's `Payment` record for the given `billing_period`, and add the student's share to `utility_amount` (increasing `amount_due` accordingly).
   - Record the full split breakdown on the `utility-bill.model` record itself (student, rental, payment, share_amount) for transparency/dispute resolution.

10. Build the owner-facing endpoints: submit a bill, list bills for an apartment or building — scoped via the Phase 1 ownership helper.

11. Log every bill submission and every resulting payment adjustment to the real `audit` module (`utility_bill_created`, `payment_utility_charge_applied`) — same pattern as every module since Phase 3.

12. Write tests: splitting math (including the rounding-remainder case, e.g., a bill that doesn't divide evenly), rejection when utilities are included in rent, rejection when zero active students, and the ownership-isolation negative test (Owner B cannot submit a bill for Owner A's apartment).

## Deliverable
Each owner has a tracked subscription tier with real usage data, can request capacity expansion, and capacity-based rules are enforced. Separately, owners who don't bundle utilities into rent can submit a bill per apartment and have it split automatically and transparently among currently active students, added to their existing monthly payment.

## Dependency Note
Expansion requests created here are consumed in Phase 7's expansion queue — design the request record with that downstream consumer in mind. The utility feature depends on Phase 3 (Buildings/Apartments), Phase 4 (Rentals — for "who's currently active"), and Phase 5 (Payments — the destination for each student's share) all being stable, which they are.
