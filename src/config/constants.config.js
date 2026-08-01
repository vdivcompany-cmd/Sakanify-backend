/**
 * constants.config.js
 *
 * Shared enums used across every module. Nothing in this project should
 * hard-code these string literals — always import from here so a rename
 * only ever happens in one place.
 */

// --- System roles ---
const ROLES = Object.freeze({
  STUDENT: 'student',
  OWNER: 'owner',
  SUPER_ADMIN: 'super-admin',
});

// --- Bed lifecycle status ---
// AVAILABLE   -> free, can be requested
// PENDING     -> locked against a single in-flight request (atomic lock, Phase 4)
// OCCUPIED    -> actively rented by a confirmed student
// MAINTENANCE -> temporarily unavailable, owner-controlled
const BED_STATUS = Object.freeze({
  AVAILABLE: 'available',
  PENDING: 'pending',
  OCCUPIED: 'occupied',
  MAINTENANCE: 'maintenance',
});

// --- Payment status (cash-only flow, Phase 5) ---
// Recurring monthly billing model, finalized in
// Docs/phase-5-cash-payment.md's "Product Decision Resolved Before
// Implementation" section: there is no separate "student says paid"
// intermediate step — the owner collects cash in person and directly
// confirms in the dashboard, so confirmation IS the transition into
// PAID/PARTIAL. This replaces the four-value PENDING/PAID/CONFIRMED/
// OVERDUE set that was scaffolded here in an earlier phase (before the
// recurring-billing decision was resolved) with the set the finalized
// Phase 5 spec actually calls for. Flagged as a deviation from the
// original scaffolding in the Phase 5 report — PAYMENT_STATUS is only
// referenced from this file before Phase 5, so the rename is isolated.
// PENDING -> awaiting the student to pay the owner in person this period
// PAID    -> owner confirmed the full amount_due was collected in cash
// PARTIAL -> owner confirmed a cash receipt less than amount_due
// OVERDUE -> pending/partial past due_date + grace period, still unpaid
const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  PARTIAL: 'partial',
  OVERDUE: 'overdue',
});

// --- Booking/request status (Phase 4) ---
// PENDING  -> awaiting owner review, bed is locked (BED_STATUS.PENDING)
// APPROVED -> owner confirmed; this is the "confirmed" state referenced in
//             Docs/phase-4-booking-engine.md — reusing the APPROVED value
//             already scaffolded here (in Phase 1) rather than introducing
//             a second, conflicting literal ("confirmed") for the same
//             meaning. Same reasoning as Phase 3's decision to keep
//             BED_STATUS as the single source of truth for bed states.
// REJECTED -> owner declined; see REQUEST_REJECTION_REASON below
// EXPIRED  -> owner never responded within the timeout window (request-expiry.job)
// CANCELLED -> student withdrew the request before the owner responded
const REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

// --- Structured rejection reasons (Phase 4) ---
const REQUEST_REJECTION_REASON = Object.freeze({
  PRICE_DISAGREEMENT: 'price_disagreement',
  ALREADY_TAKEN_OFFLINE: 'already_taken_offline',
  STUDENT_NO_SHOW_FOR_CALL: 'student_no_show_for_call',
  OTHER: 'other',
});

// --- Rental lifecycle status (Phase 4) ---
// ACTIVE   -> student is currently living in the bed; bed stays OCCUPIED
// VACATING -> student gave move-out notice; bed STILL stays OCCUPIED until
//             finalization — "vacating" is deliberately not a BED_STATUS
//             value (see Docs/phase-4-booking-engine.md's correction on
//             this point)
// CLOSED   -> move-out finalized; bed transitions back to AVAILABLE
const RENTAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  VACATING: 'vacating',
  CLOSED: 'closed',
});

module.exports = {
  ROLES,
  BED_STATUS,
  PAYMENT_STATUS,
  REQUEST_STATUS,
  REQUEST_REJECTION_REASON,
  RENTAL_STATUS,
};
