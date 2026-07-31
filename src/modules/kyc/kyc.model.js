/**
 * kyc.model.js
 *
 * Simplified KYC record, deliberately kept to exactly what's specified in
 * Docs/phase-2-students-kyc.md: national ID number, national ID photo
 * (reference), student photo (reference), verification status.
 *
 * Kept as its own collection (separate from student.model) so
 * verification status can be tracked/audited independently of the
 * general profile, per the phase spec's Implementation Step 2.
 *
 * Data-privacy note (CLAUDE.md Section 5.2): this model is designed so a
 * future anonymization request can null out national_id_number,
 * national_id_photo and student_photo (and call
 * file-storage.adapter.deleteFile on the photo references) without
 * deleting the record itself or breaking any historical
 * rental/payment references that may point at the student.
 */

const mongoose = require('mongoose');

const VERIFICATION_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
});

const kycSchema = new mongoose.Schema(
  {
    // One KYC record per student. Resubmission after rejection updates
    // this same record (see kyc.service.resubmit) rather than creating a
    // new one, so verification history stays on a single traceable
    // document.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },

    national_id_number: {
      type: String,
      required: true,
      trim: true,
      select: false, // Sensitive PII — never returned by default queries
    },

    // Reference/URL returned by the storage adapter — never raw binary,
    // never a permanent public link (CLAUDE.md Section 3.2).
    national_id_photo: {
      type: String,
      required: true,
      select: false, // Sensitive PII — never returned by default queries
    },

    student_photo: {
      type: String,
      required: true,
    },

    verification_status: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.PENDING,
    },

    // --- Minimal actor/timestamp trail for the verification decision ---
    // Section 5.3/3.9 of CLAUDE.md require every status change on
    // sensitive data to be traceable to an actor and timestamp. A
    // dedicated, centralized audit-log collection (src/modules/audit) is
    // scaffolded but not yet implemented in this codebase — that's
    // flagged as a deviation in the Phase 2 report. In the meantime this
    // field keeps the KYC record itself traceable.
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewed_at: {
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
    collection: 'kyc_records',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
kycSchema.index({ student: 1 }, { unique: true });
kycSchema.index({ verification_status: 1 });

kycSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

const Kyc = mongoose.model('Kyc', kycSchema);

module.exports = Kyc;
module.exports.VERIFICATION_STATUS = VERIFICATION_STATUS;
