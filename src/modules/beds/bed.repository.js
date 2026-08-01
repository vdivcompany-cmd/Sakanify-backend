/**
 * bed.repository.js
 *
 * Data-access layer for the Bed collection. Controllers/services never
 * touch the Bed mongoose model directly — everything goes through here,
 * per CLAUDE.md Section 7.2.
 */

const Bed = require('./bed.model');

function create(data) {
  return Bed.create(data);
}

function findById(bedId) {
  return Bed.findById(bedId);
}

function findByApartment(apartmentId, { skip = 0, limit = 20 } = {}) {
  return Bed.find({ apartment: apartmentId }).sort({ created_at: -1 }).skip(skip).limit(limit);
}

function countByApartment(apartmentId) {
  return Bed.countDocuments({ apartment: apartmentId });
}

// Unpaginated, single query for many apartments at once — used by the
// nested building->apartments->beds read so fetching N apartments' beds
// never turns into N queries (CLAUDE.md Section 4.4).
function findAllByApartmentIds(apartmentIds) {
  return Bed.find({ apartment: { $in: apartmentIds } }).sort({ created_at: -1 });
}

function updateById(bedId, updates) {
  return Bed.findByIdAndUpdate(bedId, { $set: updates }, { new: true, runValidators: true });
}

function deleteById(bedId) {
  return Bed.findByIdAndDelete(bedId);
}

/**
 * Occupancy counts grouped by status, scoped by building or apartment.
 * One aggregation query regardless of how many beds exist under the
 * filter — reused by both building- and apartment-level occupancy calls
 * (CLAUDE.md Section 4.4).
 */
function aggregateStatusCounts(filter) {
  return Bed.aggregate([
    { $match: filter },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
}

module.exports = {
  create,
  findById,
  findByApartment,
  countByApartment,
  findAllByApartmentIds,
  updateById,
  deleteById,
  aggregateStatusCounts,
};
