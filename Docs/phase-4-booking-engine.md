# Phase 4 — Booking Engine (Requests & Rentals)

## Goal
Implement the request-to-rental flow with a hard guarantee that two students can never be granted the same bed at the same time. This is the highest-risk, highest-priority module in the backend.

## Context
Flow: student requests a bed → bed soft-locks → owner reviews and contacts student offline by phone → owner confirms or rejects in the dashboard → confirmed creates a Rental and bed becomes occupied; rejected/expired returns bed to available.

**Corrected after Phase 3 review:** use the existing `BED_STATUS` enum from `src/config/constants.config.js` (`available`, `pending`, `occupied`, `maintenance`) — this enum was already built in Phase 3 specifically to support this phase's atomic locking mechanic, and Phase 3's `bed.model` already uses it. Do NOT introduce a different set of status values (an earlier draft of this document used `requested/confirmed/vacating` — that was a documentation error, now corrected). Concretely: requesting a bed transitions it `available` → `pending`; confirming a request transitions it `pending` → `occupied`; rejecting/expiring returns it `pending` → `available`.

**`vacating` is NOT a bed status.** A bed stays `occupied` for the whole duration a student lives there, including after they've given move-out notice. Track the "student gave notice, will move out soon" state on the **Rental** record instead (e.g., `rental.status = 'vacating'`), not on the bed. Only when the move-out is finalized does the bed transition `occupied` → `available`. This keeps the already-tested `BED_STATUS` enum from Phase 3 untouched.

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
├── rental.service              → Confirm rental creation, move-out/vacating flow (vacating tracked here, not on the bed)
└── rental.model                 → student reference, bed reference, confirmed date, move-in date, status (active/vacating/closed)
```

## Implementation Steps

1. Build `request.model` with the fields listed above, including a structured/enum rejection reason (`price_disagreement`, `already_taken_offline`, `student_no_show_for_call`, `other`).
2. Implement the atomic bed-locking logic in `request.service`: a single conditional `findOneAndUpdate`-style operation that only succeeds if the bed's current status is `available` (per `BED_STATUS`), transitioning it to `pending`. Test this specifically under simulated simultaneous requests.
3. Register `request-expiry.job` into `scheduler.core` (Phase 0): if an owner doesn't respond within the timeout window (e.g., 48h), auto-transition request to `expired` and bed back to `available`.
4. Build the owner-facing pending-requests endpoint, showing each student's profile/KYC summary (pulled from Phase 2).
5. Build Confirm and Reject actions: confirm transitions the bed `pending` → `occupied` and creates a `rental.model` record; reject requires a structured reason and returns the bed `pending` → `available`.
6. Build a duplicate-request cap per student (recommended: max 2 active pending requests at once) enforced in `request.service`.
7. Build `rental.model` and the move-out flow in `rental.service`: mark the rental `vacating` (bed stays `occupied`), then on finalization transition the bed `occupied` → `available` and close the rental (bed-history log from Phase 3 gets a closing entry).
8. (Optional) Build a waitlist mechanism: other interested students can be notified if a request is rejected/expires.
9. Log every state transition (bed status, request status, rental status) to the real `audit` module (built in Phase 3) via `bed-history.service` / direct `writeAuditLog()` calls — not a separate logging mechanism.
10. **Added after Phase 2 review:** Build the owner-facing student profile + KYC view endpoint here (originally scoped to Phase 2, deferred because Buildings/Requests/Rentals didn't exist yet). Use the `studentService.getFullProfileWithKyc(studentId)` function already exposed by the Phase 2 students module. Scope access via the Phase 1 ownership-scoping helper, restricted to students connected to that owner's buildings through an active or pending request/rental record built in this phase. Write the explicit isolation test: Owner A must not be able to view KYC data for a student with no relationship to Owner A's buildings.
11. **Added after Phase 3 review:** Phase 3 implemented building/apartment/bed deletion restrictions using `bed.status !== 'available'` as a temporary proxy for "has an active relationship," since Rentals didn't exist yet. Now that Rentals exist, update that restriction logic to also check for an active or vacating rental record — keep the bed-status check as an additional safety layer, but the rental relationship is now the authoritative signal.
12. Write focused tests simulating two near-simultaneous requests for the same bed — verify exactly one succeeds.

## Deliverable
A race-condition-free booking flow: request → review → confirm/reject → occupied or released, with expiry, rejection reasons, move-out (tracked via rental status), and full audit logging — verified against double-booking specifically.

## Dependency Note
Phase 5 (payments) attaches to confirmed `rental.model` records, and Phase 8 (public site) submits requests directly into this module. Do not proceed past this phase until atomic locking is explicitly tested and confirmed correct.
