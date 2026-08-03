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
    //
    // Phase 9 change (Docs/phase-9-booking-behavior-bulk-registration.md,
    // Part D): made OPTIONAL. A rental created via Part D's "Assign to Bed"
    // action (manual entry, or confirming a bulk-registration submission)
    // has no originating Request document — there was never a viewing-
    // booking/request in the loop for a tenant who already lived in the
    // building before joining the platform. `null` here specifically means
    // "created outside the request/viewing-booking flow," not "data
    // missing." Flagged as a deliberate deviation from the original Phase 4
    // schema in the Phase 9 report.
    request: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Request',
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(RENTAL_STATUS),
      default: RENTAL_STATUS.ACTIVE,
    },

    // Phase 9 addition (Part A, Product Decision 7 — "One active Rental per
    // student, platform-wide, enforced at the database level"). Denormalized
    // boolean, kept in sync with `status` on every write (true while
    // active/vacating, false once closed), rather than expressing the
    // student-uniqueness constraint directly against `status` — MongoDB's
    // partialFilterExpression only reliably supports simple equality/
    // comparison operators, not a documented `$in` across two enum values,
    // so a boolean flag is the portable way to get one partial unique index
    // that means "this student currently holds a live rental slot
    // anywhere on the platform." Flipped to false the moment
    // finalizeMoveOut() closes a rental — at that point the student is free
    // to be assigned a new bed elsewhere, which is expected (a student
    // moving between buildings across terms).
    holds_platform_slot: {
      type: Boolean,
      default: true,
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
rentalSchema.index({ bed: 1 });
rentalSchema.index({ owner_id: 1 });
rentalSchema.index({ status: 1 });
// Phase 9 addition (Part A, Product Decision 7): THE database-level
// guarantee that a student can never hold two live rentals at once,
// platform-wide — a partial unique index on `student`, scoped to documents
// where `holds_platform_slot` is true (see that field's comment above for
// why a boolean flag is used instead of a direct partial filter on
// `status`). This closes the race-condition window a plain
// check-then-create application check cannot: two near-simultaneous
// rental-creation attempts for the same student (e.g. one viewing-booking
// confirm and one Part D bulk-registration assign-to-bed, confirmed by two
// different owners at nearly the same instant) can both pass an
// application-level check, but only one can win this index.
rentalSchema.index(
  { student: 1 },
  { unique: true, partialFilterExpression: { holds_platform_slot: true } },
);

rentalSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Rental = mongoose.model('Rental', rentalSchema);

module.exports = Rental;
