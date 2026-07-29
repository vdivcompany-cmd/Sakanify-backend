# Phase 4 — Booking Engine (Requests & Rentals)

## Goal
Implement the request-to-rental flow with a hard guarantee that two students can never be granted the same bed at the same time. This is the highest-risk, highest-priority module in the backend.

## Context
Flow: student requests a bed → bed soft-locks (`requested`) → owner reviews and contacts student offline by phone → owner confirms or rejects in the dashboard → confirmed creates a Rental and bed becomes `confirmed`; rejected/expired returns bed to `available`.

**Critical requirement**: solve double-booking with an atomic, conditional database update (e.g., MongoDB `findOneAndUpdate` with a status-match condition) — NOT a message queue, NOT application-level locking. The queue/scheduler is only for the expiry job, not the locking itself.

## Folders & Files to Create This Phase

```
src/modules/requests/
├── request.routes           → Create request, list pending (owner), confirm, reject
├── request.controller
├── request.service            → Atomic bed-locking logic, duplicate-request limit enforcement
├── request.model               → student reference, bed reference, timestamp, status, rejection reason, move-in date, note
└── request-expiry.job          → Scheduled job (registered into shared/jobs/scheduler.core) auto-expiring unanswered requests after 48h

src/modules/rentals/
├── rental.routes             → Confirm rental (internal, triggered by request confirmation), move-out actions
├── rental.controller
├── rental.service              → Confirm rental creation, move-out/vacating flow
└── rental.model                 → student reference, bed reference, confirmed date, move-in date, status
```

## Implementation Steps

1. Build `request.model` with the fields listed above, including a structured/enum rejection reason (`price_disagreement`, `already_taken_offline`, `student_no_show_for_call`, `other`).
2. Implement the atomic bed-locking logic in `request.service`: a single conditional `findOneAndUpdate`-style operation that only succeeds if the bed's current status is `available`. Test this specifically under simulated simultaneous requests.
3. Register `request-expiry.job` into `scheduler.core` (Phase 0): if an owner doesn't respond within the timeout window (e.g., 48h), auto-transition request to `expired` and bed back to `available`.
4. Build the owner-facing pending-requests endpoint, showing each student's profile/KYC summary (pulled from Phase 2).
5. Build Confirm and Reject actions: confirm transitions the bed to `confirmed` and creates a `rental.model` record; reject requires a structured reason and returns the bed to `available`.
6. Build a duplicate-request cap per student (recommended: max 2 active pending requests at once) enforced in `request.service`.
7. Build `rental.model` and the move-out flow in `rental.service`: mark `vacating`, then finalize to `available` once the move-out date passes, closing the rental cleanly (bed-history log from Phase 3 gets a closing entry).
8. (Optional) Build a waitlist mechanism: other interested students can be notified if a request is rejected/expires.
9. Log every state transition (bed status, request status) to the `audit` module (built alongside this phase or already scaffolded).
10. Write focused tests simulating two near-simultaneous requests for the same bed — verify exactly one succeeds.

## Deliverable
A race-condition-free booking flow: request → review → confirm/reject → occupied or released, with expiry, rejection reasons, move-out, and full audit logging — verified against double-booking specifically.

## Dependency Note
Phase 5 (payments) attaches to confirmed `rental.model` records, and Phase 8 (public site) submits requests directly into this module. Do not proceed past this phase until atomic locking is explicitly tested and confirmed correct.
