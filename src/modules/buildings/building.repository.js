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

// Phase 7 addition (Docs/phase-7-admin.md, implementation step 7):
// platform-wide "total active buildings" metric. Every building record in
// this system is a live, active listing — there is no soft-delete/
// inactive flag on Building (deleteBuilding hard-deletes, and only once
// empty of apartments, see building.service.deleteBuilding) — so a total
// count IS the active-buildings count. Flagged as a technical decision in
// the Phase 7 report: if a future phase introduces a building-level
// active/inactive toggle, this should be revisited to filter on it.
function countAll() {
  return Building.countDocuments({});
}

// Platform-wide, unpaginated-by-owner read for Phase 7's admin
// owners/buildings table (mirrors subscription.repository.findByOwnerIds).
function countByOwnerIds(ownerIds) {
  return Building.aggregate([
    { $match: { owner_id: { $in: ownerIds } } },
    { $group: { _id: '$owner_id', count: { $sum: 1 } } },
  ]);
}

function updateById(buildingId, updates) {
  return Building.findByIdAndUpdate(buildingId, { $set: updates }, { new: true, runValidators: true });
}

function deleteById(buildingId) {
  return Building.findByIdAndDelete(buildingId);
}

/**
 * Phase 8 addition (Docs/phase-8-public-site.md): the public building
 * directory query — scoped to only the owner_ids the caller
 * (building.service.listPublicBuildings) has already resolved as
 * actively subscribed via subscriptionService.getActiveOwnerIds, with an
 * optional area (neighborhood, not distance-based per the phase spec)
 * filter. `.select()` here is a query-level minimization guarantee, not
 * just a controller-side field strip — owner_id and address.details
 * never leave the database for this query at all.
 */
function findPublic({ ownerIds, area, skip = 0, limit = 20 } = {}) {
  const filter = { owner_id: { $in: ownerIds } };
  if (area) filter.area = area;

  return Building.find(filter)
    .select('name area address.city address.street created_at')
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit);
}

function countPublic({ ownerIds, area } = {}) {
  const filter = { owner_id: { $in: ownerIds } };
  if (area) filter.area = area;
  return Building.countDocuments(filter);
}

module.exports = {
  create,
  findById,
  findByOwner,
  countByOwner,
  countAll,
  countByOwnerIds,
  updateById,
  deleteById,
  findPublic,
  countPublic,
};
