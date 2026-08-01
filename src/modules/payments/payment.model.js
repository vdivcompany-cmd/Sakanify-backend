/**
 * payment.model.js
 *
 * Recurring monthly cash-payment record, per Docs/phase-5-cash-payment.md's
 * "Product Decision Resolved Before Implementation" section: each active
 * Rental (Phase 4) generates one Payment record per billing period
 * (calendar month), and the owner confirms cash receipt per period — not
 * once for the whole tenancy.
 *
 * `student`, `bed`, `building`, `owner_id` are denormalized from the
 * Rental at creation time, same pattern as every module since Phase 3
 * (CLAUDE.md Section 4.4 — avoid N+1 population on owner-facing list/
 * history/overdue views).
 *
 * `amount_due` is copied from rental.monthly_rent at creation time, not
 * recalculated on read — see rental.model.js's monthly_rent comment.
 */

const mongoose = require('mongoose');
const { PAYMENT_STATUS } = require('../../config/constants.config');

const paymentSchema = new mongoose.Schema(
  {
    rental: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rental',
      required: true,
    },

    // --- Denormalized from the Rental at creation time ---
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

    // Billing month this record covers, "YYYY-MM" (e.g. "2026-08").
    // Combined with `rental` in a unique index below so the same rental
    // can never get two payment records for the same month (phase spec
    // step 1).
    billing_period: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}$/,
    },

    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },

    amount_due: {
      type: Number,
      required: true,
      min: 0,
    },
    amount_paid: {
      type: Number,
      default: 0,
      min: 0,
    },

    // --- Phase 6 additive retrofit (Docs/phase-6-subscriptions.md, step 8:
    // "Optional Utility Bill Splitting") ---
    // amount_due = rent_amount + utility_amount going forward.
    // rent_amount default is a FUNCTION, not a static value, specifically
    // so it also applies when Mongoose hydrates an EXISTING payment
    // document (created before this phase) that has no rent_amount field
    // stored in Mongo at all — Mongoose applies schema defaults during
    // document hydration for any path missing from the raw DB record, and
    // a function default is evaluated with `this` bound to that same
    // hydrated document, so it reads the document's own (already-loaded)
    // amount_due. This is what makes the migration non-breaking without a
    // separate backfill script: `rent_amount = amount_due` and
    // `utility_amount = 0` for every pre-Phase-6 record, satisfied purely
    // by reading through the schema — see the Phase 6 report's "Technical
    // Decisions" section. payment.service's creation paths (initial
    // payment + rollover + ensurePaymentForPeriod) set both fields
    // explicitly for every NEW record going forward, so this default only
    // ever matters for pre-existing data.
    rent_amount: {
      type: Number,
      min: 0,
      default: function rentAmountDefault() {
        return this.amount_due;
      },
    },
    utility_amount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // End of the billing_period month, plus the grace window defined in
    // payment.service — overdue-check.job compares against this field.
    // Not explicitly listed in the phase spec's field list, but required
    // to implement step 6 (overdue detection past "due_date + grace
    // period") — flagged as an added technical decision in the Phase 5
    // report.
    due_date: {
      type: Date,
      required: true,
    },

    // Set together when an owner confirms cash receipt (paid or partial).
    confirmed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    confirmed_at: {
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
    collection: 'payments',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
// Prevents duplicate payment records for the same rental+month (phase spec
// step 1) — this is the hard guarantee, not just an application check.
paymentSchema.index({ rental: 1, billing_period: 1 }, { unique: true });
paymentSchema.index({ owner_id: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ student: 1 });
paymentSchema.index({ building: 1 });
paymentSchema.index({ due_date: 1 });

paymentSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
