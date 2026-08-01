/**
 * subscription.model.js
 *
 * Tracks each Owner's Sakanify subscription tier (Docs/phase-6-subscriptions.md,
 * "Subscriptions (Original Scope)"): tier/package name, total allowed bed
 * capacity, monthly price, and account status. One subscription record
 * per owner (unique owner_id) — this is the owner's OWN bill to Sakanify,
 * distinct from a student's rent (Payment, Phase 5).
 *
 * Expansion requests ("Request Bed Expansion", step 4) are embedded as a
 * sub-array on this same document rather than a separate top-level
 * collection/file — the phase spec's folder-structure comment lists only
 * 4 files under src/modules/subscriptions/ (routes/controller/service/
 * model), with no separate expansion-request model. Embedding keeps to
 * that literal file list and makes ownership-scoping trivial (an
 * expansion request is just a sub-document of the owner's own
 * subscription — there's no separate collection an Owner B could ever
 * query into). Flagged as a technical decision in the Phase 6 report:
 * if Phase 7's Super-Admin expansion queue turns out to need a flat,
 * cross-owner, independently-paginated queue view, promoting this array
 * to its own top-level collection is the natural next step — deferred
 * for now since Phase 7 doesn't exist yet and over-building on
 * speculation isn't warranted (CLAUDE.md Section 7.5).
 */

const mongoose = require('mongoose');
const { SUBSCRIPTION_STATUS, EXPANSION_REQUEST_STATUS } = require('../../config/constants.config');

const expansionRequestSchema = new mongoose.Schema(
  {
    requested_capacity: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(EXPANSION_REQUEST_STATUS),
      default: EXPANSION_REQUEST_STATUS.PENDING,
    },
    requested_at: {
      type: Date,
      default: () => new Date(),
    },
    // Set by Phase 7's Super-Admin expansion queue when it resolves this
    // request — left null/pending indefinitely until that phase exists.
    resolved_at: {
      type: Date,
      default: null,
    },
    resolved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: true },
);

const subscriptionSchema = new mongoose.Schema(
  {
    // String, not ObjectId — same owner_id convention as every other
    // owner-scoped model (building.model.js, payment.model.js, etc.).
    owner_id: {
      type: String,
      required: true,
      unique: true,
    },

    tier_name: {
      type: String,
      required: true,
      trim: true,
    },

    total_bed_capacity: {
      type: Number,
      required: true,
      min: 1,
    },

    monthly_price: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.ACTIVE,
    },

    renewal_date: {
      type: Date,
      required: true,
    },

    expansion_requests: {
      type: [expansionRequestSchema],
      default: [],
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
    collection: 'subscriptions',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
// owner_id already gets a unique index implicitly from `unique: true`
// above; status is indexed separately since Phase 7's expansion queue and
// any future "list overdue/suspended owners" admin view will filter on it.
subscriptionSchema.index({ status: 1 });

subscriptionSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

module.exports = Subscription;
