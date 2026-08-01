/**
 * kyc.repository.js
 *
 * Data-access layer for the Kyc collection. Controllers/services never
 * touch the Kyc mongoose model directly — everything goes through here,
 * per CLAUDE.md Section 7.2.
 */

const Kyc = require('./kyc.model');

// Sensitive fields (national_id_number, national_id_photo) are declared
// `select: false` on the schema, so they're excluded by default. Callers
// that genuinely need them (KYC resubmission ownership checks, the
// verification-status review flow) opt in explicitly with `.select(...)`.

function findByStudentId(studentId) {
  return Kyc.findOne({ student: studentId });
}

function findByStudentIdWithSensitiveFields(studentId) {
  return Kyc.findOne({ student: studentId }).select('+national_id_number +national_id_photo');
}

// Batched lookup for many students at once — used by student.service's
// owner-facing pending-requests summary (Phase 4) so a page of N pending
// requests costs one Kyc query, not N (CLAUDE.md Section 4.4). Sensitive
// fields stay excluded by the schema's `select: false` default, same as
// every other read in this repository.
function findByStudentIds(studentIds) {
  return Kyc.find({ student: { $in: studentIds } });
}

function findById(kycId) {
  return Kyc.findById(kycId);
}

function create(data) {
  return Kyc.create(data);
}

function updateByStudentId(studentId, updates) {
  return Kyc.findOneAndUpdate(
    { student: studentId },
    { $set: updates },
    { new: true, runValidators: true },
  );
}

function updateStatusById(kycId, updates) {
  return Kyc.findByIdAndUpdate(kycId, { $set: updates }, { new: true, runValidators: true });
}

module.exports = {
  findByStudentId,
  findByStudentIdWithSensitiveFields,
  findByStudentIds,
  findById,
  create,
  updateByStudentId,
  updateStatusById,
};
