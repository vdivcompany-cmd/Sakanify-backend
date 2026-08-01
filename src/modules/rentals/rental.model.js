/**
 * rental.model.js
 *
 * Created the moment an owner confirms a request (request.service.confirmRequest).
 * Tracks the move-out ("vacating") state here, deliberately NOT on the
 * bed itself — see Docs/phase-4-booking-engine.md's correction: a bed
 * stays `occupied` (BED_STATUS) for the student's entire stay, including
 * after they've given notice. Only `rental.status` moves through
 * active -> vacating -> closed; the bed only changes when the rental is
 * actually closed.
 *
 * `building` and `owner_id` are denormalized from the bed at creation
 * time, same pattern as every other module this phase/last phase.
 */

const mongoose = require('mongoose');
const { RENTAL_STATUS } = require('../../config/constants.config');

const rentalSchema = new mongoose.Schema(
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

    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },
    owner_id: {
      type: String,
      required: true,
    },

    // The Request this rental was created from — kept for traceability
    // (e.g. so a dispute can be traced back to the original request note
    // / move-in date the student asked for).
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(RENTAL_STATUS),
      default: RENTAL_STATUS.ACTIVE,
    },

    confirmed_date: {
      type: Date,
      required: true,
    },

    // Added in Phase 5 (Docs/phase-5-cash-payment.md) — snapshotted from
    // bed.monthly_rent at the moment this rental is confirmed (see
    // rental.service.createRentalFromRequest), not recalculated from the
    // bed on every read. This is the authoritative rent amount for the
    // whole tenancy: every Payment record this rental generates copies
    // amount_due from here, so a later price change on the bed only ever
    // affects future/new rentals, never this one already in progress.
    monthly_rent: {
      type: Number,
      required: true,
      min: 0,
    },
    move_in_date: {
      type: Date,
      default: null,
    },

    // Set when the owner marks the rental as vacating (student gave
    // notice); the bed is untouched at this point.
    vacating_at: {
      type: Date,
      default: null,
    },

    // Set when the move-out is finalized and the bed is released back to
    // available.
    closed_at: {
      type: Date,
      default: null,
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
    collection: 'rentals',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
rentalSchema.index({ student: 1 });
rentalSchema.index({ bed: 1 });
rentalSchema.index({ owner_id: 1 });
rentalSchema.index({ status: 1 });

rentalSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Rental = mongoose.model('Rental', rentalSchema);

module.exports = Rental;
