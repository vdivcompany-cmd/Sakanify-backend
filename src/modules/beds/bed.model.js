/**
 * bed.model.js
 *
 * Bottom of the property hierarchy. `building` and `owner_id` are
 * denormalized here too (same reasoning as apartment.model.js) so
 * ownership checks and occupancy aggregations never need to populate
 * apartment -> building on every read (CLAUDE.md Section 4.4).
 *
 * Status values: this phase's spec document
 * (Docs/phase-3-buildings-apartments-beds.md) lists
 * "available/requested/confirmed/vacating" in its folder-structure
 * comment, but src/config/constants.config.js already defines a
 * `BED_STATUS` enum (available/pending/occupied/maintenance) that was
 * scaffolded specifically for this model and explicitly annotated for
 * Phase 4's atomic locking. Introducing a second, conflicting status
 * vocabulary in the same field would fracture the single source of truth
 * Phase 4 depends on. This is a deliberate deviation from the literal
 * spec wording — flagged in the Phase 3 report — in favor of the
 * already-canonical BED_STATUS constants.
 */

const mongoose = require('mongoose');
const { BED_STATUS } = require('../../config/constants.config');

const bedSchema = new mongoose.Schema(
  {
    apartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Apartment',
      required: true,
    },

    // Denormalized from Apartment.building at creation time.
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },

    // Denormalized from Building.owner_id at creation time.
    owner_id: {
      type: String,
      required: true,
    },

    // Optional sub-unit label if the owner tracks individual rooms within
    // an apartment (e.g. "Room 2 - Bed A"). Not required — many owners
    // will just track beds directly under the apartment.
    room_label: {
      type: String,
      trim: true,
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(BED_STATUS),
      default: BED_STATUS.AVAILABLE,
    },

    // Added in Phase 5 (Docs/phase-5-cash-payment.md) — the owner-set
    // monthly listing price, in EGP. Payment.amount_due is never
    // recalculated from this field directly; it's copied onto
    // rental.monthly_rent at confirmation time (see rental.model.js) and
    // locked in for that tenancy, so a later price change here only
    // affects future/new rentals. Additive field on an already-closed
    // Phase 3 model — defaults to 0 so existing beds created before this
    // phase remain valid without a data migration (project owner decision,
    // Phase 5 kickoff).
    monthly_rent: {
      type: Number,
      required: false,
      default: 0,
      min: 0,
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
    collection: 'beds',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
bedSchema.index({ apartment: 1 });
bedSchema.index({ building: 1 });
bedSchema.index({ owner_id: 1 });
bedSchema.index({ status: 1 });

bedSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Bed = mongoose.model('Bed', bedSchema);

module.exports = Bed;
