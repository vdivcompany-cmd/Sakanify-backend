/**
 * behavior-report.repository.js
 *
 * Data-access layer for the BehaviorReport collection. Controllers/
 * services never touch the model directly — everything goes through here,
 * per CLAUDE.md Section 7.2.
 */

const BehaviorReport = require('./behavior-report.model');

function create(data) {
  return BehaviorReport.create(data);
}

// Cross-owner by design (Part C, Product Decision 1) — every report ever
// filed about this student, regardless of who filed it, not scoped to a
// single owner_id the way every other list query in this project is.
function findByStudent(studentId) {
  return BehaviorReport.find({ student: studentId }).sort({ filed_at: -1 });
}

module.exports = {
  create,
  findByStudent,
};
