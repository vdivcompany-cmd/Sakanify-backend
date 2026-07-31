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
  create,
  updateByUserId,
};
