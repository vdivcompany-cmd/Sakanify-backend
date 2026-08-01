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

// Phase 6 addition (Docs/phase-6-subscriptions.md, step 2): total bed
// count across every building/apartment an owner has — the "actual bed
// count" subscription.service compares against the owner's subscribed
// capacity. Counts ALL beds regardless of status (available, occupied,
// etc.) since subscription capacity limits how many beds an owner can
// CREATE, not how many are currently rented.
function countByOwner(ownerId) {
  return Bed.countDocuments({ owner_id: ownerId });
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

/**
 * THE atomic locking primitive (Phase 4 — CLAUDE.md Section 4.5/8): a
 * single conditional `findOneAndUpdate` that only succeeds if the bed's
 * status still matches `expectedStatus` at the moment MongoDB applies the
 * update. This is a single atomic document operation — MongoDB guarantees
 * that if two requests race to flip the same bed at the same instant,
 * only one `findOneAndUpdate` call can match the filter and apply the
 * write; the loser's filter no longer matches (the status already
 * changed) and it gets back `null`. No message queue, no
 * application-level mutex/lock — the database itself is the lock.
 *
 * Returns the updated bed on success, or `null` if `expectedStatus`
 * didn't match (someone else won the race, or the bed was never in that
 * state to begin with) — callers must treat `null` as "the transition did
 * not happen" and respond accordingly (e.g. 409 Conflict).
 */
function conditionalUpdateStatus(bedId, expectedStatus, newStatus) {
  return Bed.findOneAndUpdate(
    { _id: bedId, status: expectedStatus },
    { $set: { status: newStatus, updated_at: new Date() } },
    { new: true },
  );
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
  countByOwner,
  findAllByApartmentIds,
  updateById,
  conditionalUpdateStatus,
  deleteById,
  aggregateStatusCounts,
};
