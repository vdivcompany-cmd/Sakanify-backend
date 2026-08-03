/**
 * behavior-report.model.js
 *
 * Phase 9, Part C (Docs/phase-9-booking-behavior-bulk-registration.md) —
 * cross-owner student behavior history. A deliberate, narrow exception to
 * the strict ownership-scoping rule used everywhere else in this project
 * (CLAUDE.md Section 3.3): a report is filed by one owner about a student,
 * but is visible to EVERY owner who passes the relationship gate (see
 * behavior-report.service.js's checkRelationship) — cross-building
 * visibility of tenant history is the entire point of this feature.
 *
 * This is sensitive reputational data about a real person, so every read
 * and write goes through the same audit-logging rigor as KYC data
 * (CLAUDE.md Section 5.3/3.9) — see behavior-report.service.js.
 */

const mongoose = require('mongoose');
const { BEHAVIOR_REPORT_SEVERITY } = require('../../config/constants.config');

const behaviorReportSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },

    // The owner who filed this report. Deliberately NOT called owner_id
    // (the denormalized-string convention used everywhere else for
    // ownership-SCOPING) — this field is provenance, not a scoping
    // filter, since reports are intentionally readable across owners.
    filed_by_owner: {
      type: String,
      required: true,
    },

    incident_description: {
      type: String,
      required: true,
      trim: true,
    },

    severity: {
      type: String,
      enum: Object.values(BEHAVIOR_REPORT_SEVERITY),
      required: true,
    },

    filed_at: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'behavior_reports',
    timestamps: false,
  },
);

// --- Indexes (defined alongside the model, per CLAUDE.md Section 4.1) ---
behaviorReportSchema.index({ student: 1 });
behaviorReportSchema.index({ filed_by_owner: 1 });

const BehaviorReport = mongoose.model('BehaviorReport', behaviorReportSchema);

module.exports = BehaviorReport;
