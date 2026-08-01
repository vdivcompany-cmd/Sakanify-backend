/**
 * utility-bill.model.js
 *
 * A single utility bill (electricity/water/gas) submitted by an owner for
 * one apartment and one billing period, split equally among that
 * apartment's currently active students (Docs/phase-6-subscriptions.md,
 * "Optional Utility Bill Splitting", step 9). Only relevant for buildings
 * where `building.utilities_included_in_rent === false` — see
 * utility-bill.service.submitBill for the rejection when that's not the
 * case.
 *
 * `building` and `owner_id` are denormalized from the apartment at
 * creation time, same pattern as every module since Phase 3 (CLAUDE.md
 * Section 4.4 — avoid N+1 population on owner-facing list views).
 *
 * `split` is the full breakdown recorded on the bill itself — "for
 * transparency/dispute resolution" per the phase spec's step 9 — a
 * denormalized snapshot alongside (not instead of) each affected
 * Payment record actually being updated.
 */

const mongoose = require('mongoose');
const { UTILITY_BILL_TYPE } = require('../../config/constants.config');

const splitEntrySchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },
    rental: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rental',
      required: true,
    },
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      required: true,
    },
    share_amount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

const utilityBillSchema = new mongoose.Schema(
  {
    apartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Apartment',
      required: true,
    },

    // Denormalized from Apartment.building / Apartment.owner_id at
    // creation time — never set independently by a client.
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },
    owner_id: {
      type: String,
      required: true,
    },

    bill_type: {
      type: String,
      enum: Object.values(UTILITY_BILL_TYPE),
      required: true,
    },

    // Same "YYYY-MM" convention as payment.model.js's billing_period, so
    // a bill always maps unambiguously onto the matching monthly Payment
    // record(s) it was split across.
    billing_period: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
    },

    total_amount: {
      type: Number,
      required: true,
      min: 0,
    },

    split: {
      type: [splitEntrySchema],
      default: [],
    },

    entered_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    entered_at: {
      type: Date,
      default: () => new Date(),
    },

    created_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'utility_bills',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
utilityBillSchema.index({ owner_id: 1 });
utilityBillSchema.index({ apartment: 1 });
utilityBillSchema.index({ building: 1 });
utilityBillSchema.index({ billing_period: 1 });

const UtilityBill = mongoose.model('UtilityBill', utilityBillSchema);

module.exports = UtilityBill;
