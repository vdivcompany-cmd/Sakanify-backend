# Phase 5 — Cash Payment Tracking

## Goal
Allow Owners to record and track rent payments collected in cash, in person — no payment gateway in this phase.

## Context
Confirmed flow: student pays owner in person → owner manually confirms the cash payment in the dashboard.

## Product Decision Resolved Before Implementation

**Recurring monthly billing model — confirmed (not one-time).** Student housing rent is inherently a recurring monthly obligation, not a single move-in payment. Each active `Rental` (from Phase 4) generates one `Payment` record per billing period (month). The owner confirms cash receipt per period, not once for the whole tenancy. This resolves the open design question carried since Phase 0.

## Folders & Files to Create This Phase

```
src/modules/payments/
├── payment.routes           → Confirm cash payment, view payment status/history, list overdue
├── payment.controller
├── payment.service            → Status update logic (pending → paid), partial payment, overdue detection, monthly rollover
├── payment.model               → rental reference, student/bed/building/owner_id (denormalized, same pattern as Phase 3/4), billing_period (e.g. "2026-08"), status (pending/paid/partial/overdue), amount_due, amount_paid, confirmed_by, confirmed_at
├── payment-rollover.job        → Scheduled job (registered into scheduler.core) generating next period's pending record when a rental is active and the current period is settled
├── overdue-check.job           → Scheduled job flagging pending payments past due_date + grace period as overdue
└── receipt.service             → Generates a simple digital receipt on payment confirmation
```

## Implementation Steps

1. Build `payment.model` with the fields above. `billing_period` uniquely identifies the month (combined with `rental` reference — unique index on `{rental, billing_period}` to prevent duplicate records for the same month).
2. When a Rental is created/confirmed (Phase 4), generate its first `Payment` record (`pending`, current billing period) — hook into `rental.service`'s confirm flow.
3. Build the "Confirm Cash Payment" endpoint: updates status to `paid` (or `partial`, see step 4), sets `confirmed_by`/`confirmed_at`, and writes to the real `audit` module via `auditService.writeAuditLog()` (same pattern as every module since Phase 3) — never a separate logging mechanism.
4. Build partial payment support: `amount_paid < amount_due` sets status to `partial` rather than forcing a binary choice.
5. Build `payment-rollover.job`: once a period's payment is settled (`paid`), or on a fixed monthly schedule, auto-generate the next period's `pending` record for that rental — only while the rental status (Phase 4) is `active` or `vacating`; stop generating new periods once a rental is `closed`.
6. Build `overdue-check.job`: flags `pending` payments past due date + grace period as `overdue`, registered into `scheduler.core`.
7. Build `receipt.service` for simple digital receipt generation on confirmation.
8. Build owner-facing endpoints: payment status/history per student, per building, and an overdue-accounts view — scoped via the Phase 1 ownership helper, using the same denormalized `owner_id` pattern as Buildings/Apartments/Beds/Requests/Rentals for efficient querying (no N+1, per CLAUDE.md 4.4).
9. Ensure every payment status change is logged to the audit module — confirmations, partial payments, and overdue flagging (system-actor, `actor: null`, same pattern as Phase 4's request-expiry job).

## Deliverable
Owners can view and update payment status for every student under their buildings on a monthly recurring basis, with partial payment and overdue detection working, and every change auditable — payments correctly stop generating once a rental closes.

## Dependency Note
This phase's data feeds the FinOps/cashflow dashboard widgets planned for Owner and Admin dashboards (Phase 7). It depends directly on Phase 4's `rental.model` (a payment always references an active rental) — do not build payments independent of a real rental relationship.
