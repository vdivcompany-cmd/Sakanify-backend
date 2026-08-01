/**
 * building.repository.js
 *
 * Data-access layer for the Building collection. Controllers/services
 * never touch the Building mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const Building = require('./building.model');

function create(data) {
  return Building.create(data);
}

function findById(buildingId) {
  return Building.findById(buildingId);
}

// Ownership-scoped find — every owner-facing list query filters by
// owner_id at the query level, per CLAUDE.md Section 3.3 ("enforced at
// the query level, not just at the UI level").
function findByOwner(ownerId, { skip = 0, limit = 20 } = {}) {
  return Building.find({ owner_id: ownerId }).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function countByOwner(ownerId) {
  return Building.countDocuments({ owner_id: ownerId });
}

function updateById(buildingId, updates) {
  return Building.findByIdAndUpdate(buildingId, { $set: updates }, { new: true, runValidators: true });
}

function deleteById(buildingId) {
  return Building.findByIdAndDelete(buildingId);
}

module.exports = {
  create,
  findById,
  findByOwner,
  countByOwner,
  updateById,
  deleteById,
};
