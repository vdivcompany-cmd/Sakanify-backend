/**
 * audit.model.js
 *
 * Central, append-only audit log used by every module in the system —
 * starting with bed status transitions in this phase, and KYC
 * verification decisions retrofitted from Phase 2 (see audit.service.js
 * and Docs/phase-3-buildings-apartments-beds.md's "Added After Phase 2
 * Review" section). This is the "source of truth in disputes" collection
 * required by CLAUDE.md Section 5.3: every entry is actor-stamped,
 * timestamped, and never editable or deletable once written.
 *
 * Deliberately generic (entity_type + entity_id, not a dedicated
 * collection per module) so Phase 4 (Requests/Rentals) and Phase 5
 * (Payments) can write into this exact same collection without a new
 * migration or a parallel logging mechanism.
 */

const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    // Who performed the action — a User (auth.model) id for every
    // human-triggered action. Nullable as of Phase 4: automated
    // system actions (request-expiry.job auto-expiring an unanswered
    // request and releasing its bed) have no human actor. A null actor
    // combined with a self-describing action name (e.g.
    // "request_expired") still tells you exactly WHAT happened and WHEN —
    // the audit trail stays complete, it just records "the system" instead
    // of inventing a fake user to satisfy a NOT NULL constraint.
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      default: null,
    },

    // Free-form but consistent action name, e.g. "bed_status_change",
    // "kyc_status_change". Not an enum on purpose — new modules will keep
    // adding new action names, and locking this down would mean editing
    // this shared model every time a new module starts writing audit
    // entries, defeating the point of a generic mechanism.
    action: {
      type: String,
      required: true,
      trim: true,
    },

    // What kind of thing changed, e.g. "Bed", "Kyc". Paired with
    // entity_id to identify the exact record.
    entity_type: {
      type: String,
      required: true,
      trim: true,
    },

    entity_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Snapshot of the relevant fields before/after the change. Mixed
    // (schemaless) on purpose — the shape differs per entity_type (a bed
    // status change looks nothing like a KYC verification decision), and
    // forcing a shared shape here would make this model a bottleneck for
    // every future module that wants to log something.
    before_state: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after_state: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    created_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'audit_logs',
    timestamps: false,
    // No updated_at, no pre('save') touching existing fields — this
    // collection is append-only. Nothing in this codebase should ever
    // call findOneAndUpdate/findByIdAndUpdate/deleteOne on Audit; see
    // audit.repository.js, which deliberately exposes no update/delete
    // functions at all (CLAUDE.md Section 5.3: "must never be
    // user-editable or deletable").
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
auditSchema.index({ entity_type: 1, entity_id: 1 });
auditSchema.index({ actor: 1 });
auditSchema.index({ action: 1 });
auditSchema.index({ created_at: -1 });

const Audit = mongoose.model('Audit', auditSchema);

module.exports = Audit;
