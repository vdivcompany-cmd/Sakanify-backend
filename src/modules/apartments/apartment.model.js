/**
 * apartment.model.js
 *
 * Middle tier of the property hierarchy: every apartment belongs to
 * exactly one building. owner_id is intentionally denormalized onto this
 * document (copied from the parent building at creation time) rather than
 * requiring a populate('building') on every ownership check or list
 * query — see the "technical decisions" note in the Phase 3 report for
 * the reasoning (CLAUDE.md Section 4.4: avoid N+1 / avoid an extra join
 * on every single owner-scoped read).
 */

const mongoose = require('mongoose');

const apartmentSchema = new mongoose.Schema(
  {
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },

    // Denormalized from Building.owner_id at creation time. Never set
    // independently by a client — apartment.service always derives this
    // from the parent building, so it can never drift from the building's
    // real owner (see apartment.service.createApartment).
    owner_id: {
      type: String,
      required: true,
    },

    floor: {
      type: Number,
      required: true,
      min: 0,
    },

    room_count: {
      type: Number,
      required: true,
      min: 1,
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
    collection: 'apartments',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
apartmentSchema.index({ building: 1 });
apartmentSchema.index({ owner_id: 1 });

apartmentSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Apartment = mongoose.model('Apartment', apartmentSchema);

module.exports = Apartment;
