/**
 * bulk-registration.model.js
 *
 * Phase 9, Part D (Docs/phase-9-booking-behavior-bulk-registration.md) —
 * secure self-service links for onboarding tenants who already lived in a
 * building before joining the platform.
 *
 * Technical decision (flagged in the Phase 9 report): the spec's folder
 * listing describes a single `bulk-registration.model` file containing
 * both the link record AND an embedded "pending-submissions structure."
 * This implementation instead uses TWO collections — BulkRegistrationLink
 * (this file) and BulkSubmission (bulk-submission.model.js) — because an
 * embedded array of submissions on the link document would grow
 * unbounded for a popular/long-lived link, which is exactly the kind of
 * unpaginated, ever-growing embedded structure CLAUDE.md Section 4
 * (indexes/pagination from day one, at 500k-student scale) warns against.
 * A separate, indexed, paginated collection is the safer choice at scale
 * and costs nothing in query complexity (one extra `$match` on `link`).
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const bulkRegistrationLinkSchema = new mongoose.Schema(
  {
    building: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Building',
      required: true,
    },
    owner_id: {
      type: String,
      required: true,
    },

    // Part D, Product Decision 1: cryptographically random token (128+
    // bits), stored as a hash — never plaintext, same principle as
    // password/backup-code storage (a database leak alone must not yield
    // a usable live link).
    token_hash: {
      type: String,
      required: true,
      unique: true,
    },

    // Product Decision 2: 14-day default expiry, owner-revocable at any
    // time (generating a new link invalidates the old one for that
    // building — enforced in bulk-registration.service by revoking any
    // existing non-revoked link for the same building before creating a
    // new one, not by a schema-level constraint).
    expires_at: {
      type: Date,
      required: true,
    },
    revoked_at: {
      type: Date,
      default: null,
    },

    created_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'bulk_registration_links',
    timestamps: false,
  },
);

bulkRegistrationLinkSchema.index({ building: 1 });
bulkRegistrationLinkSchema.index({ owner_id: 1 });

const BulkRegistrationLink = mongoose.model('BulkRegistrationLink', bulkRegistrationLinkSchema);

const RAW_TOKEN_BYTES = 32; // 256 bits — comfortably over the spec's 128+ bit minimum

function generateRawToken() {
  return crypto.randomBytes(RAW_TOKEN_BYTES).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = BulkRegistrationLink;
module.exports.generateRawToken = generateRawToken;
module.exports.hashToken = hashToken;
