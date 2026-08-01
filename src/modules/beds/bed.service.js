/**
 * bed.service.js
 *
 * Business logic for bed CRUD, status transitions, and occupancy
 * calculation. Occupancy calculation logic lives here (per the phase
 * spec) so building.service and apartment.service both call into this
 * one place rather than duplicating the aggregation — Subscriptions
 * (Phase 6) and Admin (Phase 7) will reuse it too.
 *
 * NOTE on Phase 4: this file defines the status field and plain
 * create/update/delete operations only. The atomic, concurrency-safe
 * locking operation (findOneAndUpdate with a status precondition, tested
 * under concurrent load) is Phase 4's job — see
 * Docs/phase-3-buildings-apartments-beds.md's Dependency Note. Nothing
 * here should be mistaken for that guarantee.
 */

const mongoose = require('mongoose');
const bedRepository = require('./bed.repository');
const bedHistoryService = require('./bed-history.service');
const { BED_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

async function createBed(apartmentId, buildingId, ownerId, data) {
  return bedRepository.create({
    apartment: apartmentId,
    building: buildingId,
    owner_id: ownerId,
    room_label: data.room_label || null,
    status: BED_STATUS.AVAILABLE,
  });
}

async function listBedsForApartment(apartmentId, { skip, limit }) {
  const [beds, total] = await Promise.all([
    bedRepository.findByApartment(apartmentId, { skip, limit }),
    bedRepository.countByApartment(apartmentId),
  ]);
  return { beds, total };
}

/**
 * Bed count for a single apartment — used by apartment.service to decide
 * whether an apartment is safe to delete (implementation step 8), without
 * apartment.service reaching into the Bed collection directly
 * (CLAUDE.md Section 7.2).
 */
async function countBedsForApartment(apartmentId) {
  return bedRepository.countByApartment(apartmentId);
}

async function getBedById(bedId) {
  const bed = await bedRepository.findById(bedId);
  if (!bed) {
    throw new AppError('Bed not found', 404);
  }
  return bed;
}

/**
 * Update a bed. If `status` is part of the update and actually differs
 * from the current value, records the transition via bed-history.service
 * (which writes to the real audit log) — implementation step 9's sibling
 * requirement for bed status changes, mirroring the KYC retrofit.
 */
async function updateBed(bedId, updates, actorUserId) {
  const bed = await getBedById(bedId);

  const isStatusChanging = Object.prototype.hasOwnProperty.call(updates, 'status') && updates.status !== bed.status;
  const previousStatus = bed.status;

  const updated = await bedRepository.updateById(bedId, updates);

  if (isStatusChanging) {
    await bedHistoryService.recordStatusChange(bedId, actorUserId, previousStatus, updates.status);
  }

  return updated;
}

/**
 * Block deletion of a bed unless it is currently AVAILABLE. Beds in any
 * other state (pending/occupied/maintenance) represent an active
 * relationship of some kind even before Phase 4's Rentals model exists —
 * see the Phase 3 report's "Technical Decisions" section for why this
 * uses the bed's own status field as the signal, instead of the phase
 * spec's literal "active rentals" wording (Rentals doesn't exist yet).
 */
async function deleteBed(bedId) {
  const bed = await getBedById(bedId);

  if (bed.status !== BED_STATUS.AVAILABLE) {
    throw new AppError(
      `Cannot delete a bed with status "${bed.status}" — only beds with status "${BED_STATUS.AVAILABLE}" can be deleted`,
      409,
    );
  }

  await bedRepository.deleteById(bedId);
}

function toObjectId(id) {
  return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;
}

/**
 * Occupancy calculation: counts of beds per status, scoped to either a
 * building or a single apartment. One aggregation query regardless of
 * bed count (CLAUDE.md Section 4.4 — no N+1).
 */
async function computeOccupancy({ buildingId, apartmentId }) {
  const filter = {};
  if (buildingId) filter.building = toObjectId(buildingId);
  if (apartmentId) filter.apartment = toObjectId(apartmentId);

  const grouped = await bedRepository.aggregateStatusCounts(filter);

  const counts = Object.values(BED_STATUS).reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  let total = 0;
  for (const row of grouped) {
    counts[row._id] = row.count;
    total += row.count;
  }

  return {
    total,
    occupied: counts[BED_STATUS.OCCUPIED],
    available: counts[BED_STATUS.AVAILABLE],
    pending: counts[BED_STATUS.PENDING],
    maintenance: counts[BED_STATUS.MAINTENANCE],
  };
}

/**
 * Beds for many apartments in one query — used by building.service's
 * nested structure read to avoid an N+1 per-apartment fetch.
 */
async function listAllBedsForApartments(apartmentIds) {
  return bedRepository.findAllByApartmentIds(apartmentIds);
}

module.exports = {
  createBed,
  listBedsForApartment,
  countBedsForApartment,
  getBedById,
  updateBed,
  deleteBed,
  computeOccupancy,
  listAllBedsForApartments,
};
