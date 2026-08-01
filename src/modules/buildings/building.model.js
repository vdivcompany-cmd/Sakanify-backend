/**
 * building.model.js
 *
 * Top of the property hierarchy: Building -> Apartment -> Bed. Every
 * building belongs to exactly one owner via owner_id (the same String
 * owner_id used across the codebase for ownership scoping — see
 * auth.model.js; owners are identified by owner_id, not their User _id,
 * because a future phase may let an owner account invite teammates who
 * share the same owner_id).
 */

const mongoose = require('mongoose');

const buildingSchema = new mongoose.Schema(
  {
    // String, not ObjectId ref — matches owner_id's type on auth.model.js
    // (User.owner_id is a String UUID, not a Mongo ObjectId), so
    // ownership-scoping comparisons (req.user.ownerId === building.owner_id)
    // never need a populate() or a type cast.
    owner_id: {
      type: String,
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Area/neighborhood, not distance-based (per phase spec — Sakanify
    // does not do proximity-to-campus calculations in this phase).
    area: {
      type: String,
      required: true,
      trim: true,
    },

    address: {
      city: { type: String, required: true, trim: true },
      street: { type: String, trim: true, default: null },
      details: { type: String, trim: true, default: null }, // building number, landmark, etc.
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
    collection: 'buildings',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
buildingSchema.index({ owner_id: 1 });
buildingSchema.index({ area: 1 });

buildingSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Building = mongoose.model('Building', buildingSchema);

module.exports = Building;
