/**
 * student.model.js
 *
 * Lean student profile. Deliberately restricted to the fields listed in
 * Docs/phase-2-students-kyc.md — do NOT add fields beyond this list
 * (no selfie/face-match, no blood type, no sleep schedule, no
 * quiet-level preference), per CLAUDE.md Section 5.1 (minimize data
 * collection to what's explicitly approved).
 *
 * KYC data (national ID, verification status) intentionally lives in a
 * separate collection (kyc.model) so it can be tracked/audited
 * independently of the general profile — see kyc.model.js.
 */

const mongoose = require('mongoose');

const SMOKING_PREFERENCE = Object.freeze({
  SMOKER: 'smoker',
  NON_SMOKER: 'non_smoker',
});

const studentSchema = new mongoose.Schema(
  {
    // --- Link back to the auth User (Phase 1) that owns this profile ---
    // One student profile per User account. Not owner-scoped: students
    // have no owner_id (see auth.model.js).
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // --- Lean profile fields (exactly as specified, nothing more) ---
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Denormalized copy of the linked User's phone, kept in sync at
    // registration time, so the profile document is self-describing for
    // reads (owner-facing views, future Requests module) without an
    // extra join back to the auth module for the common case.
    phone: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    age: {
      type: Number,
      min: 16,
      max: 99,
      default: null,
    },

    // Reference/URL returned by the storage adapter — never raw binary.
    profile_photo: {
      type: String,
      default: null,
    },

    college: {
      type: String,
      required: true,
      trim: true,
    },

    academic_year: {
      type: Number,
      required: true,
      min: 1,
      max: 7,
    },

    university_id: {
      type: String,
      trim: true,
      default: null,
    },

    smoking_preference: {
      type: String,
      enum: Object.values(SMOKING_PREFERENCE),
      required: true,
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
    collection: 'students',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
studentSchema.index({ user: 1 }, { unique: true });
studentSchema.index({ phone: 1 });
studentSchema.index({ college: 1 });

studentSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Student = mongoose.model('Student', studentSchema);

module.exports = Student;
module.exports.SMOKING_PREFERENCE = SMOKING_PREFERENCE;
