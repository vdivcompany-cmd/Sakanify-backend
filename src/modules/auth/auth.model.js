/**
 * auth.model.js
 *
 * User authentication model supporting three roles: student (phone-based OTP),
 * owner (email/password), and super-admin (email/password).
 *
 * Ownership scoping: Students have no owner_id. Owners and their associated data
 * are scoped by owner_id (shared ID for the owner account).
 */

const mongoose = require('mongoose');
const { ROLES } = require('../../config/constants.config');

const userSchema = new mongoose.Schema(
  {
    // --- Email (optional for students, required for owners/admins) ---
    // NOTE: no `sparse`/`unique`/`index` here on purpose — the unique+sparse
    // index is defined once, explicitly, via userSchema.index() below.
    // Setting `sparse: true` on the field AND calling schema.index() for the
    // same field both register an index, which is what caused the
    // "Duplicate schema index" warning from Mongoose.
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    // --- Phone (optional for owners/admins, required for students) ---
    // Same reasoning as `email` above — index defined once, explicitly, below.
    phone: {
      type: String,
      trim: true,
    },

    // --- Password hash (required for owners/admins, null for students with OTP) ---
    password_hash: {
      type: String,
      default: null,
      select: false, // Never return password_hash in queries by default
    },

    // --- User role ---
    role: {
      type: String,
      enum: [ROLES.STUDENT, ROLES.OWNER, ROLES.SUPER_ADMIN],
      required: true,
    },

    // --- Owner ID (for ownership scoping) ---
    // Students: null (no owner association)
    // Owners: their own UUID (one owner per account)
    // Super-admins: null (not owner-scoped)
    owner_id: {
      type: String,
      default: null,
    },

    // --- Account status ---
    status: {
      type: String,
      enum: ['active', 'suspended', 'deleted'],
      default: 'active',
    },

    // --- Refresh token invalidation list ---
    // Used to invalidate all existing tokens on password reset or logout
    invalidated_token_versions: {
      type: [String],
      default: [],
    },

    // --- Real token-invalidation cutoff (Phase 7 fix) ---
    // Every access/refresh token carries a `jti` and a standard JWT `iat`
    // (issued-at) claim. Any token whose `iat` is at or before this
    // timestamp is treated as invalidated by auth.middleware.verifyToken,
    // regardless of whether it's still within its normal expiry window.
    //
    // This field was added because `invalidated_token_versions` above
    // (Phase 1) was write-only: logout()/initiatePasswordReset() pushed a
    // random string into that array, but nothing in the codebase ever
    // read it back or compared it against an incoming token — so logout
    // and password-reset never actually revoked an already-issued access
    // token, only prevented reuse of the specific refresh token string
    // that had already expired/rotated anyway. Discovered while wiring
    // Phase 7's suspend-must-really-invalidate-sessions requirement (see
    // admin.service.suspendOwner) and reusing what was assumed to be a
    // working Phase 1 mechanism. Flagged as a pre-existing defect fix in
    // the Phase 7 report per CLAUDE.md Section 7.3a/7.4 — this is a
    // genuine behavior change for logout()/initiatePasswordReset() too
    // (their sessions are now actually revoked immediately instead of
    // only at natural access-token expiry), not just new Phase 7 code.
    tokens_invalidated_at: {
      type: Date,
      default: null,
    },

    // --- Timestamps ---
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
    collection: 'users',
    timestamps: false, // We manage timestamps manually
  },
);

// --- Indexes ---
// Email unique index (sparse to allow null for students)
userSchema.index({ email: 1 }, { sparse: true, unique: true });

// Phone unique index (sparse to allow null for owners)
userSchema.index({ phone: 1 }, { sparse: true, unique: true });

// Role index (for querying all users of a role)
userSchema.index({ role: 1 });

// Owner_id index (for scoping owner data)
userSchema.index({ owner_id: 1 });

// Status index (for active/suspended filtering)
userSchema.index({ status: 1 });

// --- Pre-save hook: update updated_at ---
userSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
