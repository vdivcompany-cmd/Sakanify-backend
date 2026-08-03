/**
 * bulk-registration.repository.js
 *
 * Data-access layer for both BulkRegistrationLink and BulkSubmission —
 * kept in one repository file (unlike most other modules' one-model-one-
 * repository convention) since the two collections are only ever read/
 * written together by this single owning module, per CLAUDE.md Section
 * 7.2's "module is self-contained" rule; splitting them into two
 * repository files would add ceremony with no isolation benefit.
 */

const BulkRegistrationLink = require('./bulk-registration.model');
const BulkSubmission = require('./bulk-submission.model');
const { BULK_SUBMISSION_STATUS } = require('../../config/constants.config');

// --- Link ---

function createLink(data) {
  return BulkRegistrationLink.create(data);
}

function findLinkByTokenHash(tokenHash) {
  return BulkRegistrationLink.findOne({ token_hash: tokenHash });
}

function findActiveLinkForBuilding(buildingId) {
  return BulkRegistrationLink.findOne({ building: buildingId, revoked_at: null });
}

function revokeLink(linkId) {
  return BulkRegistrationLink.findByIdAndUpdate(linkId, { $set: { revoked_at: new Date() } }, { new: true });
}

function findLinkById(linkId) {
  return BulkRegistrationLink.findById(linkId);
}

// --- Submission ---

function createSubmission(data) {
  return BulkSubmission.create(data);
}

function findSubmissionById(submissionId) {
  return BulkSubmission.findById(submissionId);
}

function findPendingForOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  return BulkSubmission.find({ owner_id: ownerId, status: BULK_SUBMISSION_STATUS.PENDING })
    .sort({ submitted_at: 1 })
    .skip(skip)
    .limit(limit);
}

function countPendingForOwner(ownerId) {
  return BulkSubmission.countDocuments({ owner_id: ownerId, status: BULK_SUBMISSION_STATUS.PENDING });
}

function updateSubmissionById(submissionId, updates) {
  return BulkSubmission.findByIdAndUpdate(submissionId, { $set: updates }, { new: true, runValidators: true });
}

/**
 * Part D, Product Decision 4: per-token rate limit, independent of
 * source-IP diversity — how many submissions has THIS link received in
 * the trailing window, regardless of which IPs they came from.
 */
function countSubmissionsForLinkSince(linkId, since) {
  return BulkSubmission.countDocuments({ link: linkId, submitted_at: { $gte: since } });
}

module.exports = {
  createLink,
  findLinkByTokenHash,
  findActiveLinkForBuilding,
  revokeLink,
  findLinkById,
  createSubmission,
  findSubmissionById,
  findPendingForOwner,
  countPendingForOwner,
  updateSubmissionById,
  countSubmissionsForLinkSince,
};
