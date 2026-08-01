/**
 * utility-bill.repository.js
 *
 * Data-access layer for the UtilityBill collection. Controllers/services
 * never touch the UtilityBill mongoose model directly — everything goes
 * through here, per CLAUDE.md Section 7.2.
 */

const UtilityBill = require('./utility-bill.model');

function create(data) {
  return UtilityBill.create(data);
}

function findById(billId) {
  return UtilityBill.findById(billId);
}

// Every list endpoint supports pagination from day one (CLAUDE.md
// Section 4.2). owner_id is always applied — mandatory ownership-scoping
// filter (CLAUDE.md Section 3.3).
function findByApartment(ownerId, apartmentId, { skip = 0, limit = 20 } = {}) {
  return UtilityBill.find({ owner_id: ownerId, apartment: apartmentId })
    .sort({ entered_at: -1 })
    .skip(skip)
    .limit(limit);
}

function countByApartment(ownerId, apartmentId) {
  return UtilityBill.countDocuments({ owner_id: ownerId, apartment: apartmentId });
}

function findByBuilding(ownerId, buildingId, { skip = 0, limit = 20 } = {}) {
  return UtilityBill.find({ owner_id: ownerId, building: buildingId })
    .sort({ entered_at: -1 })
    .skip(skip)
    .limit(limit);
}

function countByBuilding(ownerId, buildingId) {
  return UtilityBill.countDocuments({ owner_id: ownerId, building: buildingId });
}

module.exports = {
  create,
  findById,
  findByApartment,
  countByApartment,
  findByBuilding,
  countByBuilding,
};
