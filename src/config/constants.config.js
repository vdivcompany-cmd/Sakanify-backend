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
// PENDING   -> awaiting the student to pay the owner in person
// PAID      -> student says paid, awaiting owner confirmation
// CONFIRMED -> owner confirmed cash receipt
// OVERDUE   -> payment window passed unpaid
const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  CONFIRMED: 'confirmed',
  OVERDUE: 'overdue',
});

// --- Booking/request status (Phase 4) ---
const REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

module.exports = {
  ROLES,
  BED_STATUS,
  PAYMENT_STATUS,
  REQUEST_STATUS,
};
