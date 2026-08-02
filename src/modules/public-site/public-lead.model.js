/**
 * public-lead.model.js
 *
 * A lightweight record of interest submitted through the anonymous
 * public-site "Request to View/Book" form. THIS IS NOT A REQUEST — see
 * Docs/phase-8-public-site.md's "Critical Design Decision — Public Leads
 * Are NOT Requests" and requests/request.model.js's doc comment for the
 * distinction. A PublicLead never causes a Bed status transition and is
 * never read or written by anything in the requests module; the two
 * collections are completely decoupled on purpose, so a bug or future
 * change in one can never accidentally reach into the other's
 * correctness guarantees.
 *
 * `bed`/`building`/`owner_id` are denormalized from the target Bed at
 * creation time (same convention as request.model.js), so the
 * owner-facing "my public leads" list and its ownership-scoping check
 * never need to populate through bed -> apartment -> building.
 */

const mongoose = require('mongoose');
const { PUBLIC_LEAD_STATUS } = require('../../config/constants.config');

const publicLeadSchema = new mongoose.Schema(
  {
    // Freeform, unverified visitor-supplied contact info — this is the
    // entire point of the corrected design: no OTP, no KYC, no account.
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    note: {
      type: String,
      trim: true,
      default: null,
    },

    bed: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bed',
      required: true,
    },
    // Denormalized from Bed.building at creation time.
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },
    // Denormalized from Bed.owner_id at creation time — same String
    // owner_id convention used across the codebase (see
    // building.model.js), so the owner-facing list/ownership-scoping
    // check never needs a populate() or a type cast.
    owner_id: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(PUBLIC_LEAD_STATUS),
      default: PUBLIC_LEAD_STATUS.NEW,
    },

    // Named submitted_at (not created_at) per the phase spec's explicit
    // field list — kept as the literal spec name since this is a
    // brand-new model with no prior convention to stay consistent with.
    submitted_at: {
      type: Date,
      default: () => new Date(),
    },
    updated_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'public_leads',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
publicLeadSchema.index({ owner_id: 1 });
publicLeadSchema.index({ status: 1 });
publicLeadSchema.index({ bed: 1 });
publicLeadSchema.index({ building: 1 });
publicLeadSchema.index({ submitted_at: -1 });

publicLeadSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const PublicLead = mongoose.model('PublicLead', publicLeadSchema);

module.exports = PublicLead;
