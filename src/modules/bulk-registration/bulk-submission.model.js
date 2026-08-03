/**
 * bulk-submission.model.js
 *
 * See bulk-registration.model.js's header comment for why this is a
 * separate collection rather than an embedded array on the link record.
 *
 * A submission NEVER directly creates or touches a Rental (Part D,
 * Product Decision 3) — `declared_bed` is a self-reported, non-binding
 * suggestion (Product Decision 6) that only pre-fills the owner's review
 * screen. The owner's explicit "Assign to Bed" action
 * (bulk-registration.service.assignToBed) is the only path from a
 * submission to a real Rental.
 */

const mongoose = require('mongoose');
const { BULK_SUBMISSION_STATUS } = require('../../config/constants.config');

const bulkSubmissionSchema = new mongoose.Schema(
  {
    link: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BulkRegistrationLink',
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

    // The real Student profile created at submission time (this
    // implementation creates the actual User+Student+Kyc records
    // immediately, reusing Phase 1/2's existing registration services
    // rather than staging a raw, un-normalized data snapshot — see
    // bulk-registration.service.js's submitViaLink for the full
    // reasoning). The submission record itself is the "pending owner
    // review" gate; the underlying student account is real and KYC'd from
    // the start, exactly as if they had registered directly.
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },

    // Self-declared by the student during submission (Product Decision 6)
    // — non-binding, pre-fills the owner's review screen only.
    declared_bed: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bed',
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(BULK_SUBMISSION_STATUS),
      default: BULK_SUBMISSION_STATUS.PENDING,
    },

    // Set once assignToBed() succeeds.
    resulting_rental: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rental',
      default: null,
    },

    submitted_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'bulk_submissions',
    timestamps: false,
  },
);

bulkSubmissionSchema.index({ link: 1 });
bulkSubmissionSchema.index({ owner_id: 1, status: 1 });
bulkSubmissionSchema.index({ link: 1, submitted_at: 1 }); // backs the per-token rate-limit count query

const BulkSubmission = mongoose.model('BulkSubmission', bulkSubmissionSchema);

module.exports = BulkSubmission;
