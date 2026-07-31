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
