/**
 * request.model.js
 *
 * A student's request to rent a specific bed. This is the document that
 * "holds" a bed in the pending state while the owner reviews it offline
 * (per Docs/phase-4-booking-engine.md's flow: student requests -> bed
 * soft-locks -> owner calls the student -> owner confirms/rejects).
 *
 * `building` and `owner_id` are denormalized from the target bed at
 * request-creation time (same pattern as Phase 3's apartment/bed
 * denormalization) so the owner-facing pending-requests query and every
 * ownership check never need to populate through bed -> apartment ->
 * building just to find out which owner a request belongs to.
 */

const mongoose = require('mongoose');
const { REQUEST_STATUS, REQUEST_REJECTION_REASON } = require('../../config/constants.config');

const requestSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },

    bed: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bed',
      required: true,
    },

    // Denormalized from Bed.building / Bed.owner_id at creation time —
    // never re-derived later, since a bed's building/owner never changes
    // after creation in this system.
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },
    owner_id: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(REQUEST_STATUS),
      default: REQUEST_STATUS.PENDING,
    },

    // Only meaningful when status === REJECTED.
    rejection_reason: {
      type: String,
      enum: Object.values(REQUEST_REJECTION_REASON),
      default: null,
    },
    rejection_note: {
      type: String,
      trim: true,
      default: null,
    },

    move_in_date: {
      type: Date,
      default: null,
    },

    // Phase 9 addition (Docs/phase-9-booking-behavior-bulk-registration.md,
    // Part A, Product Decision 6 — "No-show handling"). Owner-set, optional.
    // When set, request.service.setAppointmentDate() overwrites expires_at
    // with appointment_date + a 48h grace period (reusing the existing
    // expires_at field/index rather than adding a second expiry clock — see
    // request.service.js's comment on this decision), so the same
    // request-expiry.job that already handles the default 48h-unanswered
    // case also auto-marks a no-show appointment expired with zero new
    // scheduled-job infrastructure.
    appointment_date: {
      type: Date,
      default: null,
    },

    // Free-text note from the student to the owner (e.g. "I can move in
    // any day after the 5th").
    note: {
      type: String,
      trim: true,
      default: null,
    },

    // When the owner actually confirmed/rejected/the request expired.
    responded_at: {
      type: Date,
      default: null,
    },

    // Computed at creation as created_at + the expiry window (48h) —
    // stored (not recomputed) so request-expiry.job can query for "past
    // due" requests directly via an index, without recalculating a
    // timestamp per document on every job run.
    expires_at: {
      type: Date,
      required: true,
    },

    created_at: {
      type: Date,
      default: () => new Date(),
    },
    updated_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'requests',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
requestSchema.index({ student: 1 });
requestSchema.index({ bed: 1 });
requestSchema.index({ owner_id: 1 });
requestSchema.index({ status: 1 });
// Compound index backing request-expiry.job's batch query
// (status === PENDING AND expires_at <= now).
requestSchema.index({ status: 1, expires_at: 1 });
// Phase 9 addition (Part A, implementation step 1): stops the same
// student spamming duplicate pending viewing-bookings/requests for the
// SAME bed — scoped to status === PENDING only (a partial index, not a
// blanket unique constraint) so the bed can always be requested again by
// the same student after a prior request was rejected/expired/lost the
// bed_taken race, per the existing "should allow the bed to be requested
// again after rejection" behavior (unchanged from Phase 4).
requestSchema.index(
  { student: 1, bed: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

requestSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Request = mongoose.model('Request', requestSchema);

module.exports = Request;
