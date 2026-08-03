/**
 * request.repository.js
 *
 * Data-access layer for the Request collection. Controllers/services
 * never touch the Request mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const Request = require('./request.model');
const { REQUEST_STATUS } = require('../../config/constants.config');

function create(data) {
  return Request.create(data);
}

function findById(requestId) {
  return Request.findById(requestId);
}

/**
 * How many active (pending) requests a student currently has — backs the
 * duplicate-request cap (implementation step 6). A plain count, not part
 * of the atomic locking guarantee — see request.service.createRequest for
 * why that's an acceptable, deliberate distinction (this is a soft
 * business rule, not a correctness guarantee like bed double-booking).
 */
function countPendingForStudent(studentId) {
  return Request.countDocuments({ student: studentId, status: REQUEST_STATUS.PENDING });
}

function findPendingForOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  return Request.find({ owner_id: ownerId, status: REQUEST_STATUS.PENDING })
    .sort({ created_at: 1 }) // oldest first — owners should work through the queue in order
    .skip(skip)
    .limit(limit);
}

function countPendingForOwner(ownerId) {
  return Request.countDocuments({ owner_id: ownerId, status: REQUEST_STATUS.PENDING });
}

function findMineForStudent(studentId, { skip = 0, limit = 20 } = {}) {
  return Request.find({ student: studentId }).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function countMineForStudent(studentId) {
  return Request.countDocuments({ student: studentId });
}

function updateById(requestId, updates) {
  return Request.findByIdAndUpdate(requestId, { $set: updates }, { new: true, runValidators: true });
}

/**
 * Batch query backing request-expiry.job (CLAUDE.md Section 4.6: process
 * in batches, never load the whole collection into memory). Callers loop,
 * calling this repeatedly until it returns fewer than `limit` documents.
 */
function findExpiredPending(limit) {
  return Request.find({ status: REQUEST_STATUS.PENDING, expires_at: { $lte: new Date() } })
    .sort({ expires_at: 1 })
    .limit(limit);
}

/**
 * Phase 9 addition (Part A, implementation step 5): on a successful
 * confirm, bulk-mark every OTHER pending request for the same bed as
 * BED_TAKEN — one write regardless of how many pending requests exist for
 * that bed (CLAUDE.md Section 4.4, no N+1 loop-and-update-per-document).
 * Excludes the just-confirmed request itself via `$ne`.
 */
function markSiblingsBedTaken(bedId, excludeRequestId) {
  return Request.updateMany(
    { bed: bedId, status: REQUEST_STATUS.PENDING, _id: { $ne: excludeRequestId } },
    { $set: { status: REQUEST_STATUS.BED_TAKEN, responded_at: new Date(), updated_at: new Date() } },
  );
}

/**
 * Does a PENDING request exist linking this student to this owner? Used
 * by the owner-facing KYC-view isolation check (implementation step 10) —
 * one half of "connected through an active or pending request/rental".
 */
function existsPendingForStudentAndOwner(studentId, ownerId) {
  return Request.exists({ student: studentId, owner_id: ownerId, status: REQUEST_STATUS.PENDING });
}

/**
 * Phase 9 addition (Part C, Product Decision 2): does ANY request — any
 * status, past or present — link this student to this owner? Deliberately
 * broader than existsPendingForStudentAndOwner above (which only counts
 * PENDING relationships, for the Phase 4 KYC-view isolation check) — the
 * behavior-report gate is about "did this owner ever legitimately house or
 * consider housing this student," which a rejected/expired/bed_taken
 * request already establishes just as validly as a pending one.
 */
function existsAnyForStudentAndOwner(studentId, ownerId) {
  return Request.exists({ student: studentId, owner_id: ownerId });
}

// Phase 7 addition (Docs/phase-7-admin.md, implementation step 7):
// platform-wide request-status breakdown for the "total requests vs.
// confirmed rentals" conversion funnel — one aggregation query regardless
// of how many requests exist (CLAUDE.md Section 4.4/8), same pattern as
// bed.repository.aggregateStatusCounts.
function aggregateStatusCounts() {
  return Request.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
}

module.exports = {
  create,
  findById,
  countPendingForStudent,
  findPendingForOwner,
  countPendingForOwner,
  findMineForStudent,
  countMineForStudent,
  updateById,
  findExpiredPending,
  markSiblingsBedTaken,
  existsPendingForStudentAndOwner,
  existsAnyForStudentAndOwner,
  aggregateStatusCounts,
};
