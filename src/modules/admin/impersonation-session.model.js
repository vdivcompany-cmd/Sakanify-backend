/**
 * impersonation-session.model.js
 *
 * Phase 7 addition — NOT in the phase spec's literal folder-structure
 * comment (Docs/phase-7-admin.md lists only admin.routes/controller/
 * service and expansion-queue.service), so this is flagged as a
 * deviation in the Phase 7 report per CLAUDE.md Section 7.4.
 *
 * Why it exists: implementation point 4 requires impersonation tokens to
 * be "a distinct, short-lived token... Log the start of every
 * impersonation session explicitly; if an 'end impersonation' action
 * exists, log that too." A write-only audit-log entry can record the
 * start, but there is nothing to check a token against at request time to
 * know whether a specific impersonation session has since been ended —
 * exactly the same category of bug as the pre-existing
 * invalidated_token_versions gap fixed on auth.model.js this same phase
 * (see that file's comment). This tiny collection is the thing
 * auth.middleware.verifyToken actually checks a live impersonation
 * token's `jti` against, so "end impersonation" is real revocation, not a
 * cosmetic log entry.
 *
 * Every session is still also written to the central audit log via
 * auditService (start AND end) — this collection is the fast, jti-keyed
 * lookup structure the audit log itself is not indexed for; it is not a
 * replacement for the audit trail.
 */

const mongoose = require('mongoose');

const impersonationSessionSchema = new mongoose.Schema(
  {
    // Matches the `jti` claim on the impersonation JWT itself — this is
    // the join key auth.middleware.verifyToken looks up on every request
    // made with an impersonation-type token.
    jti: {
      type: String,
      required: true,
      unique: true,
    },

    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Same String owner_id convention as every owner-scoped model.
    owner_id: {
      type: String,
      required: true,
    },

    // The target owner's own User account id — this is what the
    // impersonation token's `userId` claim carries, so downstream
    // ownership-scoping code sees exactly what it would for the real
    // owner logged in normally.
    target_user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    issued_at: {
      type: Date,
      default: () => new Date(),
    },

    // ~30 minutes from issuance, per implementation point 4. Sessions
    // past this are treated as invalid even if never explicitly ended —
    // auth.middleware.verifyToken relies on the JWT's own `exp` for that
    // check (jwt.verify already throws on an expired token), this field
    // exists so the admin-facing session list can show "expires at X"
    // without decoding a token.
    expires_at: {
      type: Date,
      required: true,
    },

    ended_at: {
      type: Date,
      default: null,
    },
    ended_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    collection: 'impersonation_sessions',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
// jti already gets a unique index implicitly from `unique: true` above —
// this is the hot-path lookup on every impersonation-token request.
impersonationSessionSchema.index({ admin: 1 });
impersonationSessionSchema.index({ owner_id: 1 });

const ImpersonationSession = mongoose.model('ImpersonationSession', impersonationSessionSchema);

module.exports = ImpersonationSession;
