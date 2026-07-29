# Phase 5 — Cash Payment Tracking

## Goal
Allow Owners to record and track rent payments, which are collected in cash in person (no payment gateway in this phase).

## Context for the Implementer
The confirmed flow is: student pays the owner in person, then the owner manually updates the student's status in the dashboard from `pending` to `rented` (or `paid`, depending on the final naming decision below). There is currently one open design decision that must be resolved before or at the start of this phase — see "Design Decision Required" below.

## Design Decision Required (resolve before building)
Determine whether the `pending → rented` status represents:
- **(A) A one-time confirmation** (e.g., initial move-in payment only), in which case ongoing monthly rent still needs a separate recurring payment record structure, OR
- **(B) A recurring monthly status** (the same field is reset to `pending` and re-confirmed every month), in which case this status effectively **is** the monthly payment record and no separate structure is needed.

Document whichever decision is made, since it determines the model structure in the steps below.

## Steps

1. **Build the Payment model** based on the resolved design decision above. At minimum, each payment record should support: associated rental/student/bed reference, status (`pending`, `rented`/`paid`, `partial`, `overdue`), amount due, amount paid, the billing period (e.g., month/year) if recurring, and confirmation metadata (who confirmed it, when).

2. **Build the "Confirm Cash Payment" endpoint** for owners: updates the relevant payment/status record and writes an entry to the audit log (who confirmed, when, for which student/period).

3. **Build partial payment support**: allow an owner to record an amount paid that is less than the amount due, with the record correctly reflecting a `partial` status rather than forcing a binary paid/unpaid choice.

4. **If the recurring model (B) was chosen**: build automatic generation of the next period's payment record as `pending` once the current period is marked paid (or via a scheduled rollover job using the Phase 0 scheduler).

5. **Build overdue detection logic**: if a payment remains `pending` past its due date plus a defined grace period, automatically flag it as `overdue` (via a scheduled job).

6. **Build a simple digital receipt generation** on payment confirmation (e.g., a structured receipt record or generated document) — this is a nice-to-have that adds professionalism but is not the highest priority; confirm scope with the project owner before allocating significant time to it.

7. **Build owner-facing endpoints** to view payment status/history per student, per building, and to see overdue accounts at a glance.

8. **Ensure all payment status changes are logged** to the audit service from Phase 3, since payment disputes are a realistic scenario this data may need to resolve later.

## Deliverable
Owners can view and update payment status for every student under their buildings, with partial payment and overdue detection working correctly, and every change fully auditable.

## Dependency Note
This phase's output (real per-student payment data) is what powers the FinOps/cashflow widgets planned for the Owner Dashboard (Phase 7) and Admin Dashboard — ensure the data model here is clean and queryable before those dashboards are built.
