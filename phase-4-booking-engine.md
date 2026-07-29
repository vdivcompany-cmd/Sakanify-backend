# Phase 4 — Booking Engine (Requests & Rentals)

## Goal
Implement the core request-to-rental flow, with a hard guarantee that two students can never be granted the same bed at the same time. This is the highest-risk, highest-priority module in the entire backend — treat it accordingly.

## Context for the Implementer
The flow works as follows: a student submits a request for a specific bed → the bed is soft-locked (`requested` status) → the owner reviews the request and contacts the student offline (by phone, outside the system) → the owner confirms or rejects the request in the dashboard → on confirmation, the bed becomes `confirmed`/occupied and a Rental record is created; on rejection or timeout, the bed returns to `available`.

**Critical technical requirement**: the double-booking problem must be solved using an **atomic, conditional database update** (e.g., MongoDB's `findOneAndUpdate` with a status-match condition), NOT with a message queue and NOT with application-level locking. A queue solves a different problem (asynchronous side-effects) and does not, by itself, guarantee only one of two simultaneous requests succeeds. Use the queue infrastructure from Phase 0 only for the scheduled expiry job described below, not for the locking itself.

## Steps

1. **Build the Request model**: student reference, bed reference, request timestamp, status (`pending`, `confirmed`, `rejected`, `expired`), rejection reason (structured/enum — e.g., `price_disagreement`, `already_taken_offline`, `student_no_show_for_call`, `other`), desired move-in date, optional note field.

2. **Implement the atomic bed-locking logic**: when a student requests a bed, perform a single atomic conditional update that only succeeds if the bed's current status is `available`. If another request already changed the status, the second request must fail cleanly and inform the student the bed is no longer available. Document and test this specific logic carefully — it is the core integrity guarantee of the whole system.

3. **Build the request-expiry scheduled job** (using the scheduler engine from Phase 0): if an owner does not respond to a request within a defined timeout window (e.g., 48 hours), automatically transition the request to `expired` and the bed back to `available`.

4. **Build the Owner-facing pending requests endpoint**: list all pending requests for the owner's buildings, showing the student's profile/KYC summary (pulled from Phase 2) for quick review.

5. **Build the Confirm and Reject actions** for the owner: confirming transitions the bed to `confirmed` and creates a Rental record (see step 7); rejecting requires selecting a structured reason and transitions the bed back to `available`.

6. **Build a duplicate-request limit rule for students**: decide and implement a cap on how many active (pending) requests a single student can have at once across the platform (recommended: 2), to prevent students from holding multiple beds "in reserve" without serious intent.

7. **Build the Rental model**: student reference, bed reference, confirmed date, move-in date, status, and a reference point for the payment status that will be managed in Phase 5.

8. **Build the move-out flow**: an action to mark a rental as `vacating` (student gave notice), and a final step to mark the bed `available` again once the move-out date passes, closing out the rental record and bed history cleanly so the next student's history does not merge with the previous occupant's.

9. **Build a waitlist mechanism (optional but recommended)**: allow other students to express interest in a bed that is currently `requested`, and automatically notify the next interested student if the original request is rejected or expires.

10. **Log every state transition** (bed status changes, request status changes) to the audit/history service built in Phase 3, including which actor (student, owner, or the expiry job) triggered each change.

11. **Write focused test cases for the race condition**: simulate two near-simultaneous requests for the same bed and verify exactly one succeeds and the other receives a clear "bed no longer available" response, under repeated/stress testing.

## Deliverable
A fully working, race-condition-free booking flow: request → owner review → confirm/reject → occupied or released, including expiry handling, rejection reasons, move-out flow, and complete audit logging — verified specifically against simultaneous double-booking attempts.

## Dependency Note
This module is a prerequisite for Phase 5 (payments attach to confirmed Rentals) and Phase 8 (the public site submits requests directly into this module). Do not proceed past this phase until the atomic locking behavior has been explicitly tested and confirmed correct.
