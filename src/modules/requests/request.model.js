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

requestSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Request = mongoose.model('Request', requestSchema);

module.exports = Request;
