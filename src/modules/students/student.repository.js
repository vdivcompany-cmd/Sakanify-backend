/**
 * student.repository.js
 *
 * Data-access layer for the Student collection. Controllers/services never
 * touch the Student mongoose model directly — everything goes through
 * here, per CLAUDE.md Section 7.2.
 */

const Student = require('./student.model');

function findByUserId(userId) {
  return Student.findOne({ user: userId });
}

function findById(studentId) {
  return Student.findById(studentId);
}

// Batched lookup for many students at once — used by
// student.service.getFullProfilesWithKycForIds (Phase 4's owner-facing
// pending-requests list), one query regardless of page size
// (CLAUDE.md Section 4.4).
function findByIds(studentIds) {
  return Student.find({ _id: { $in: studentIds } });
}

function create(data) {
  return Student.create(data);
}

function updateByUserId(userId, updates) {
  return Student.findOneAndUpdate(
    { user: userId },
    { $set: updates },
    { new: true, runValidators: true },
  );
}

module.exports = {
  findByUserId,
  findById,
  findByIds,
  create,
  updateByUserId,
};
