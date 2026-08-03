# Phase 9 — Public Viewing-Booking Redesign, Behavior Reports & Secure Bulk Tenant Registration

## Goal
Three major additions requested directly by the project owner, to be sent to Claude Desktop only after Remediation Passes 2 and 3 both close successfully: (A) redesign the public-site booking flow around non-exclusive "viewing bookings," locking the bed only at confirmation time; (B) let prospective students see which college a bed's current occupant studies at; (C) let owners check a student's cross-building behavior history before confirming a booking; (D) a secure way for owners to onboard tenants who already lived in their building before joining the platform.

## Context — Why Part A Deliberately Changes Already-Closed Phase 4 Behavior
The current booking engine (Phase 4) locks a bed to `pending` the instant a single request is created, rejecting any further request for that bed until it's resolved. The real-world requirement here is different: **many students should be able to book a viewing for the same bed at once** — this is normal and expected — and the bed only becomes truly reserved **the moment the owner confirms after receiving cash**. This is an intentional, explicit redesign, not a bug fix, and must be treated with the same rigor as the original atomic-locking work.

---

# Part A — Viewing-Booking Flow (Public-Site-Originated)

## Product Decisions Resolved

1. **Atomicity moves from request-creation to confirmation.** Creating a viewing-booking never locks the bed and never rejects based on other pending viewing-bookings for the same bed. The only atomic, race-condition-protected operation is **confirmation** — exactly one viewing-booking per bed can ever be confirmed, using the same atomic conditional-update pattern already proven in Phase 4 (`findOneAndUpdate` with a status guard), just moved to this step instead.
2. **On confirmation, every other pending viewing-booking for that same bed is automatically marked `bed_taken`** (kept for the record, never silently deleted) so other students can see, next time they check their own bookings, that the bed went to someone else.
3. **Registration is required to submit a viewing-booking**, using the existing Phase 2 student registration + KYC flow exactly as-is (name, phone/OTP, college, National ID number + photo, student photo) — no new lighter-weight registration path. A student registering through this public funnel becomes a normal, fully-KYC'd student going forward.
4. **The public site only ever shows a bed as reserved/unavailable when it has a confirmed, active Rental** — never just because it has pending viewing-bookings. This preserves the "many people can be interested" model visually, not just structurally.
5. **Owner contact stays manual** (WhatsApp/SMS/phone, outside the system) — consistent with the project's standing no-automated-notifications decision. The system holds the viewing-booking record and lets the owner note an appointment date on it for their own tracking; it does not send anything automatically.
6. **No-show handling**: the owner can record an appointment date on a viewing-booking. A scheduled job (same pattern as Phase 4's `request-expiry.job`) auto-marks a viewing-booking `expired` if its appointment date has passed by more than a grace period (recommend 48 hours) with no confirmation, keeping the owner's queue clean without manual cleanup.
7. **One active Rental per student, platform-wide, enforced at the database level.** A student who already has a Rental with status `active` or `vacating` anywhere on the platform must not be able to acquire a second one — whether via this Part's confirm action, Part D's assign-to-bed action, or any other path. This is enforced with a **partial unique index** on the `rental` collection: unique on `student`, filtered to documents where `status` is `active` or `vacating`. This is a database-level guarantee, not just an application-level check-then-create — it closes the race-condition window where two near-simultaneous confirmations for the same student (e.g., one viewing-booking and one bulk-registration submission from Part D, confirmed by two different owners at nearly the same instant) could otherwise both succeed. Once a student's Rental is finalized to `closed` (real move-out), the constraint no longer applies and they're free to be assigned a new bed elsewhere — this is expected and correct (a student moving between buildings across terms).
8. **National ID uniqueness at the account level.** To stop the same real person from creating multiple student accounts (with different phone numbers) specifically to bypass decision 7, `kyc.national_id_number` must be a unique index — no two student accounts may ever share the same National ID number.

## Shared Guard Used Everywhere a Rental Is Created
Build one function, `rentalService.assertNoActiveRental(studentId)` (or rely directly on the partial unique index and catch the resulting duplicate-key error, converted to a clean 409 via the Section 3a error classifier) — call it from every single code path that creates a Rental: this Part's confirm-viewing-booking action, Part D's assign-to-bed action, and any legacy Phase 4 direct-request-confirm path that might still be reachable. Do not implement this check separately in more than one place.

## Folders & Files

```
src/modules/viewing-bookings/
├── viewing-booking.routes         → Public: create; Student: list mine; Owner: list pending for my buildings, set appointment date, confirm, reject
├── viewing-booking.controller
├── viewing-booking.service          → Non-exclusive creation; atomic confirm (the bed lock happens HERE, not at creation); bulk-mark-siblings-as-bed_taken on confirm
├── viewing-booking.model             → student ref, bed ref (+building/owner_id denormalized), status (pending/confirmed/rejected/bed_taken/expired), appointment_date (owner-set, optional), created_at
└── viewing-booking-expiry.job         → Scheduled job (registered into scheduler.core), same batching/idempotency pattern as request-expiry.job
```

## Implementation Steps

1. Build `viewing-booking.model`. No unique constraint per bed (multiple pending records per bed are expected and valid) — only a unique constraint on `{student, bed}` to stop the same student spamming duplicate bookings for the same bed.
2. Build the public "Create Viewing Booking" endpoint: if the caller isn't an authenticated student, respond with a clear signal to complete Phase 2 registration first (reuse that flow entirely — do not duplicate it), then allow resubmission once registered. Creating a viewing-booking must NOT touch `bed.status` — confirm this with an explicit test.
3. Build the owner-facing "Pending Viewing Bookings" list (ownership-scoped, paginated), showing each student's profile/KYC summary via the existing `studentService.getFullProfileWithKyc()`.
4. Build the owner action to set/update `appointment_date` on a viewing-booking.
5. Build the atomic "Confirm Viewing Booking" endpoint: a conditional update requiring `bed.status === 'available'` at the moment of confirm (same atomic pattern Phase 4 already proved), transitioning it to `occupied`, creating the real `Rental` and initial `Payment` record by calling Phase 4/5's existing services directly — do not duplicate their logic. On success, bulk-update every other `pending` viewing-booking for that bed to `bed_taken`.
6. Build the owner "Reject Viewing Booking" endpoint (structured reason, same pattern as Phase 4's rejection reasons).
7. Build `viewing-booking-expiry.job` per decision 6, registered into `scheduler.core`.
8. Add the partial unique index on `rental` (student + status in active/vacating, per decision 7) and the National ID uniqueness index on `kyc.national_id_number` (per decision 8). Wire the Confirm action's Rental-creation step to catch the resulting duplicate-key error and return a clean, clearly-worded 409 ("this student already has an active rental") via the Section 3a error classifier — not a raw database error.
9. Write tests — the core new guarantee is a **concurrency test proving exactly one confirmation wins** even with many pre-existing pending viewing-bookings for the same bed racing to confirm simultaneously (adapt Phase 4's original concurrency test structure, but the race is now at confirm-time across many existing records, not at creation-time). Treat this with the same rigor as Phase 4's original atomic-lock test — it is the single most important test in this phase. Also test: creation never changes bed status; confirming one auto-marks siblings `bed_taken`; a student cannot double-book the same bed; the expiry job's idempotency/batching; **and the cross-flow race** — simulate a student with one pending viewing-booking and one pending Part D bulk-registration submission, both attempted to confirm/assign at nearly the same instant, and verify exactly one succeeds while the other is cleanly rejected via the partial unique index.

---

# Part B — Roommate College Visibility

## Product Decision
For any bed with a currently active, confirmed Rental, the public building/apartment detail view (Phase 8) may expose **only that occupant's college** — nothing else (no name, no photo, no phone number). This lets a prospective student judge room compatibility with zero real privacy exposure.

## Implementation Steps
1. In Phase 8's building/apartment detail endpoint, for each occupied bed, include a `current_occupant_college` field sourced from the occupying student's profile. Write an explicit test confirming no other student field is ever included in this response.
2. No new model needed — this is a read-only projection addition to an already-existing Phase 8 endpoint.

---

# Part C — Cross-Owner Student Behavior Reports & Gated National ID Search

## Product Decisions Resolved

1. **Behavior reports are filed by one owner about a student, and are visible to other owners** — a deliberate, narrow exception to the strict ownership-scoping rule used everywhere else, because cross-building visibility of tenant history is the entire point of the feature.
2. **The National ID search is gated, not a free-text lookup any owner can run on any student.** An owner may only search/view a student's behavior history if that owner currently has, or has had, an actual relationship with that student — a viewing-booking, request, or rental connecting them. This prevents the feature from becoming an open tool for browsing strangers' reputations with no legitimate reason. Every search is audit-logged regardless (who searched, for whom, when) as an additional deterrent and paper trail.
3. **"Send a message with the details" means the system prepares content for manual sending**, not automated messaging (consistent with the standing no-notifications-module decision) — rejecting a booking for behavior reasons returns the student's and guardian's phone numbers plus a suggested message body, for the owner to copy and send via their own WhatsApp/SMS.

## Folders & Files

```
src/modules/behavior-reports/
├── behavior-report.routes         → File a report (gated by relationship), search by National ID (gated by relationship)
├── behavior-report.controller
├── behavior-report.service          → Relationship-gating check, report creation, search aggregation
└── behavior-report.model             → student ref, filed_by_owner ref, incident_description, severity (enum), filed_at
```

## Implementation Steps

1. Build `behavior-report.model`. A report can only be filed by an owner who has/had a real relationship with the student (same relationship check as decision 2) — enforce this at creation too, not just at search time, so an owner can't file a report about a student they never actually housed.
2. Build the "Search by National ID" endpoint: resolve the ID to a student, verify the searching owner has a qualifying relationship (any viewing-booking/request/rental, any status, past or present) with that student — reject clearly if not. On success, return the student's profile/KYC summary plus every behavior report filed about them by any owner (intentionally cross-owner, not just the searching owner's own reports).
3. Build the "File Behavior Report" endpoint, same relationship-gating as step 2.
4. Extend Part A's "Reject Viewing Booking" endpoint with an optional `behavior_report_ids` reference and a response that includes the student's + guardian's phone numbers plus a generated message template — this endpoint never sends anything itself, only prepares content for the owner.
5. Audit-log every search (who searched, which student, when) and every report filed — this is sensitive reputational data about a real person and deserves the same rigor as KYC data.
6. Write tests — the relationship-gating negative test (an owner with zero history with a student cannot search or see their reports) is the most important test here, with the same rigor as every ownership-isolation test elsewhere in this project, even though visibility here is intentionally cross-owner once gated.

---

# Part D — Secure Self-Service Bulk Tenant Registration Links

## Goal
Let an owner onboard tenants who already lived in their building before joining the platform — either by entering their data manually, or by generating a secure link tenants use to self-register, tied to that specific building.

## Product Decisions Resolved (Security-Focused — This Is a New Public Entry Point)

1. **Link tokens are cryptographically random** (128+ bits, e.g. `crypto.randomBytes(32).toString('hex')`) and **stored as a hash**, never plaintext — same principle as password/backup-code storage, so a database leak alone doesn't yield usable live links.
2. **Links expire** (recommend 14 days) and are **owner-revocable** at any time (generating a new link invalidates the old one for that building).
3. **A submission via the link never directly creates a Rental.** It creates a "Bulk Self-Registration" record (student data + KYC, tied to the building) that the **owner must review and manually assign to a specific bed** — this stops a leaked link from letting an attacker inject fabricated tenants directly into confirmed occupancy records.
4. **Rate-limited by IP (standard) AND by the link token itself** (a cap on total submissions per link per hour, independent of source-IP diversity) — protects against a leaked/publicly-posted link being spammed from many different IPs.
5. **Manual entry by the owner directly creates a Rental** (owner-authenticated, ownership-scoped, same atomic bed check used everywhere) — the simpler of the two onboarding paths, no new security surface since it's just an authenticated owner action.
6. **The student self-declares their apartment/room/bed during the same submission form**, picked from the building's currently-available beds (same picker UX as the public site). This is stored as a *declared/suggested* selection on the pending submission — it pre-fills the owner's review screen for speed, but it is NOT binding by itself and does NOT create or touch any Rental on its own. The owner still explicitly confirms (or corrects, if the student picked wrong) via the same "Assign to Bed" action from decision 3 — preserving the exact same protection: a leaked link cannot be used to silently self-assign into a real occupancy record, even if the submitter names a specific bed.

## Folders & Files

```
src/modules/bulk-registration/
├── bulk-registration.routes         → Owner: generate/revoke link, list pending submissions, assign a submission to a bed (creates the Rental), manual-entry-direct-to-rental
├── bulk-registration.controller
├── bulk-registration.service          → Token generation/hashing/validation, rate-limit-by-token logic, submission creation, assign-to-bed (reuses Part A's atomic bed-check)
└── bulk-registration.model             → building ref, owner ref, token_hash, expires_at, revoked_at (nullable), created_at, plus a pending-submissions structure: student data snapshot, KYC data, declared_bed reference (self-selected by the student, non-binding — see decision 6), submitted_at, status (pending/assigned/rejected)
```

## Implementation Steps

1. Build `bulk-registration.model` (the link record + pending-submissions structure), per decisions 1–2 and 6.
2. Build "Generate Link" (owner, ownership-scoped to their own building) and "Revoke Link" endpoints.
3. Build the public "Submit via Link" endpoint: validate the token against its hash, check expiry/revocation, apply the per-token rate limit (decision 4) in addition to standard per-IP limiting, collect the same Phase 2 registration + KYC fields, let the student pick their apartment/room/bed from that building's currently-available beds (same picker pattern as the public site's browsing flow), and create a pending submission with that as the `declared_bed` — never a Rental directly (decision 3).
4. Build the owner-facing "Pending Submissions" list — pre-filled/highlighting each student's `declared_bed` for fast review — and the "Assign to Bed" action, which defaults to the declared bed but lets the owner pick a different one if the student's self-report was wrong. This reuses the exact same atomic bed-availability function from Part A's confirm step, AND the same one-active-rental-per-student guard (Part A, decisions 7–8) — do not write a second implementation of either.
5. Build the "Manual Entry" endpoint for direct owner-entered tenant data (no link involved) going straight to Rental creation, same atomic check.
6. Write tests: token cannot be guessed/brute-forced within a reasonable attempt budget (test entropy/format, not a real brute-force run), expired/revoked links are rejected, per-token rate limit triggers independent of source IP, a submission — including its `declared_bed` — never creates or touches a Rental until explicitly confirmed by the owner via "Assign to Bed," and assign-to-bed correctly rejects if the target bed is no longer available (whether that's the declared bed or an owner-corrected one).

---

## Overall Deliverable
A complete, non-exclusive public viewing-booking flow with confirmation-time atomic locking, minimal-exposure roommate college visibility, a gated cross-owner tenant behavior-history system, and a secure self-service path for onboarding pre-existing tenants — every new public-facing surface in this phase rate-limited and audit-logged to the same standard as every prior phase.

## Dependency Note
Part A changes Phase 4's core semantics — re-run the full Phase 4 suite and expect some of its original tests (specifically ones asserting a bed locks at request-creation time) to need rewriting, not just re-passing, since the behavior they tested is intentionally different now. Document every such changed test explicitly in the phase report. Parts B, C, and D are additive and lower-risk to already-closed phases.

## Sequencing Note
Do not send this to Claude Desktop until Remediation Pass 2 (Super-Admin MFA) and Pass 3 (Redis rate limiting) have both closed with confirmed GitHub Actions evidence, per the project owner's explicit sequencing instruction.
