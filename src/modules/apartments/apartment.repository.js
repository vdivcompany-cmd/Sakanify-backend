/**
 * apartment.repository.js
 *
 * Data-access layer for the Apartment collection. Controllers/services
 * never touch the Apartment mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const Apartment = require('./apartment.model');

function create(data) {
  return Apartment.create(data);
}

function findById(apartmentId) {
  return Apartment.findById(apartmentId);
}

function findByBuilding(buildingId, { skip = 0, limit = 20 } = {}) {
  return Apartment.find({ building: buildingId }).sort({ floor: 1, created_at: -1 }).skip(skip).limit(limit);
}

function countByBuilding(buildingId) {
  return Apartment.countDocuments({ building: buildingId });
}

// Unpaginated — used only for the nested building->apartments->beds read
// (a single owner's single building's apartment count is small and
// bounded; see Docs/phase-3-buildings-apartments-beds.md Implementation
// Step 6). Never used for a plain list endpoint.
function findAllByBuilding(buildingId) {
  return Apartment.find({ building: buildingId }).sort({ floor: 1 });
}

function updateById(apartmentId, updates) {
  return Apartment.findByIdAndUpdate(apartmentId, { $set: updates }, { new: true, runValidators: true });
}

function deleteById(apartmentId) {
  return Apartment.findByIdAndDelete(apartmentId);
}

module.exports = {
  create,
  findById,
  findByBuilding,
  countByBuilding,
  findAllByBuilding,
  updateById,
  deleteById,
};
