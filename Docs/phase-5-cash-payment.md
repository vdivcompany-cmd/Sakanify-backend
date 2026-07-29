# Phase 5 — Cash Payment Tracking

## Goal
Allow Owners to record and track rent payments collected in cash, in person — no payment gateway in this phase.

## Context
Confirmed flow: student pays owner in person → owner manually updates the student's status in the dashboard from `pending` to `rented`.

## Folders & Files to Create This Phase

```
src/modules/payments/
├── payment.routes           → Confirm cash payment, view payment status/history
├── payment.controller
├── payment.service            → Status update logic (pending → rented), overdue detection, optional recurring rollover
├── payment.model               → rental/student/bed reference, status (pending/rented/partial/overdue), amount_due, amount_paid, billing period (if recurring), confirmed_by, confirmed_at
└── receipt.service             → Generates a simple digital receipt on payment confirmation
```

## Implementation Steps

1. Build `payment.model` supporting: rental/student/bed reference, status, amount due/paid, billing period (if recurring model chosen), confirmation metadata.
2. Build the "Confirm Cash Payment" endpoint in `payment.controller`/`payment.service`: updates status, writes to the `audit` module (who confirmed, when, for which student/period).
3. Build partial payment support: an amount paid less than amount due sets status to `partial` rather than forcing a binary choice.
4. If a recurring monthly model is used: build automatic generation of the next period's `pending` record once the current period is marked paid, via a job registered into `scheduler.core`.
5. Build overdue detection: a job that flags payments remaining `pending` past due date + grace period as `overdue`.
6. Build `receipt.service` for simple digital receipt generation on confirmation.
7. Build owner-facing endpoints to view payment status/history per student and per building, and to see overdue accounts at a glance.
8. Ensure every payment status change is logged to the `audit` module.

## Deliverable
Owners can view and update payment status for every student under their buildings, with partial payment and overdue detection working, and every change auditable.

## Dependency Note
This phase's data feeds the FinOps/cashflow dashboard widgets planned for Owner and Admin dashboards — keep the model clean and queryable.
