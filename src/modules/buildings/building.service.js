/**
 * building.service.js
 *
 * Business logic for building CRUD, the nested
 * building->apartments->beds read, and building-level occupancy.
 * Delegates to apartment.service/bed.service for anything below the
 * Building collection itself, per CLAUDE.md Section 7.2.
 */

const buildingRepository = require('./building.repository');
const apartmentService = require('../apartments/apartment.service');
const bedService = require('../beds/bed.service');
const auditService = require('../audit/audit.service');
// Phase 8 addition (Docs/phase-8-public-site.md) — the public directory's
// eligibility gate ("buildings not subscribed must never appear") lives
// in the subscriptions module; called here rather than querying
// Subscription directly, per CLAUDE.md Section 7.2. No load-order cycle:
// subscription.service already requires bed.service, and neither
// subscription.service nor bed.service requires building.service back.
const subscriptionService = require('../subscriptions/subscription.service');
const { AppError } = require('../../middleware/error-handler.middleware');

async function createBuilding(ownerId, data) {
  return buildingRepository.create({
    owner_id: ownerId,
    name: data.name,
    area: data.area,
    address: data.address,
  });
}

async function listBuildingsForOwner(ownerId, { skip, limit }) {
  const [buildings, total] = await Promise.all([
    buildingRepository.findByOwner(ownerId, { skip, limit }),
    buildingRepository.countByOwner(ownerId),
  ]);
  return { buildings, total };
}

async function getBuildingById(buildingId) {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw new AppError('Building not found', 404);
  }
  return building;
}

/**
 * Full nested structure: building -> its apartments -> their beds, for
 * dashboard consumption (implementation step 6). Two extra queries total
 * (all apartments for the building, then all beds for those apartment
 * ids in one $in query) regardless of how many apartments/beds exist —
 * never N+1 (CLAUDE.md Section 4.4).
 */
async function getBuildingWithStructure(buildingId) {
  const building = await getBuildingById(buildingId);
  const apartments = await apartmentService.listAllApartmentsForBuilding(building._id);

  const apartmentIds = apartments.map((apt) => apt._id);
  const beds = apartmentIds.length > 0 ? await bedService.listAllBedsForApartments(apartmentIds) : [];

  const bedsByApartment = beds.reduce((acc, bed) => {
    const key = bed.apartment.toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(bed);
    return acc;
  }, {});

  const apartmentsWithBeds = apartments.map((apt) => ({
    ...apt.toObject(),
    beds: bedsByApartment[apt._id.toString()] || [],
  }));

  return {
    ...building.toObject(),
    apartments: apartmentsWithBeds,
  };
}

async function updateBuilding(buildingId, updates) {
  const building = await buildingRepository.updateById(buildingId, updates);
  if (!building) {
    throw new AppError('Building not found', 404);
  }
  return building;
}

/**
 * Block deletion of a building that still has apartments under it
 * (implementation step 8). This is the building-level half of the same
 * hierarchy-integrity rule apartment.service enforces for beds — see
 * apartment.service.deleteApartment and the Phase 3 report's note on why
 * this uses the existing hierarchy as the signal rather than the spec's
 * literal "active rentals" wording (Rentals doesn't exist until Phase 4).
 */
async function deleteBuilding(buildingId) {
  await getBuildingById(buildingId); // 404 if missing

  const { total: apartmentCount } = await apartmentService.listApartmentsForBuilding(buildingId, { skip: 0, limit: 1 });

  if (apartmentCount > 0) {
    throw new AppError(
      `Cannot delete building: ${apartmentCount} apartment(s) still exist under it. Delete or reassign its apartments first.`,
      409,
    );
  }

  await buildingRepository.deleteById(buildingId);
}

async function getBuildingOccupancy(buildingId) {
  await getBuildingById(buildingId); // 404 if missing
  return bedService.computeOccupancy({ buildingId });
}

/**
 * Phase 6 addition (Docs/phase-6-subscriptions.md, step 7): owner-facing
 * toggle for the "does this building's rent already include utilities"
 * setting. Defaults to `true` on every building (see building.model.js),
 * so this is purely opt-in — nothing changes for an owner who never calls
 * this. A dedicated function (rather than routing it through the generic
 * updateBuilding) so the audit trail records this specific business event
 * with its own action name, distinct from a plain field edit.
 */
async function setUtilitiesIncludedInRent(buildingId, utilitiesIncludedInRent, actorUserId) {
  const building = await getBuildingById(buildingId); // 404 if missing
  const before = building.utilities_included_in_rent;

  const updated = await buildingRepository.updateById(buildingId, {
    utilities_included_in_rent: utilitiesIncludedInRent,
  });

  await auditService.writeAuditLog({
    actor: actorUserId,
    action: 'building_utilities_setting_changed',
    entityType: 'Building',
    entityId: buildingId,
    beforeState: { utilities_included_in_rent: before },
    afterState: { utilities_included_in_rent: updated.utilities_included_in_rent },
  });

  return updated;
}

/**
 * Phase 7 addition (Docs/phase-7-admin.md, implementation step 7):
 * platform-wide "total active buildings" metric for the Super-Admin
 * dashboard — see building.repository.countAll's comment for what
 * "active" means here.
 */
async function countAllBuildings() {
  return buildingRepository.countAll();
}

/**
 * Phase 7 addition: buildings-per-owner counts for many owners in one
 * query — backs admin.service's platform-wide owners/buildings table
 * without an N+1 per-owner count (CLAUDE.md Section 4.4).
 */
async function countBuildingsByOwnerIds(ownerIds) {
  return buildingRepository.countByOwnerIds(ownerIds);
}

/**
 * Phase 8 addition (Docs/phase-8-public-site.md, implementation steps
 * 1-2): the public building directory. Only buildings whose owner
 * currently has an ACTIVE subscription appear at all — resolved via
 * subscriptionService.getActiveOwnerIds() rather than a direct
 * Subscription query (CLAUDE.md Section 7.2) — with an optional area
 * (neighborhood, not distance-based) filter narrowing that same set.
 * Returns an empty page (not an error) when no owner is currently
 * actively subscribed, since that's a legitimate, expected state rather
 * than a failure.
 */
async function listPublicBuildings({ area = null, skip = 0, limit = 20 } = {}) {
  const activeOwnerIds = await subscriptionService.getActiveOwnerIds();
  if (activeOwnerIds.length === 0) {
    return { buildings: [], total: 0 };
  }

  const [buildings, total] = await Promise.all([
    buildingRepository.findPublic({ ownerIds: activeOwnerIds, area, skip, limit }),
    buildingRepository.countPublic({ ownerIds: activeOwnerIds, area }),
  ]);

  return { buildings, total };
}

/**
 * Phase 8 addition (implementation step 3): single building detail for
 * the public directory. Throws a 404 — not a 403 — for a building whose
 * owner is not (or no longer) actively subscribed, deliberately
 * indistinguishable from "building doesn't exist" so a delisted/
 * suspended owner's building id can't be probed/enumerated from outside
 * (an unauthenticated surface, per this phase's spec, needs this same
 * existence-leakage discipline CLAUDE.md's data-minimization rules apply
 * elsewhere).
 *
 * Occupancy is collapsed to a single rounded percentage before it's
 * returned — never bedService.computeOccupancy's raw
 * available/occupied/pending/maintenance breakdown, since for a small
 * building that breakdown gets close enough to a per-bed map to defeat
 * implementation step 6's "no exact per-bed availability map" rule.
 */
async function getPublicBuildingDetail(buildingId) {
  const building = await getBuildingById(buildingId); // 404 if missing at all

  const isPubliclyListed = await subscriptionService.isOwnerPubliclyListed(building.owner_id);
  if (!isPubliclyListed) {
    throw new AppError('Building not found', 404);
  }

  const occupancy = await bedService.computeOccupancy({ buildingId: building._id });
  const occupancyPercent = occupancy.total > 0
    ? Math.round((occupancy.occupied / occupancy.total) * 100)
    : 0;

  return {
    id: building._id,
    name: building.name,
    area: building.area,
    address: { city: building.address.city, street: building.address.street },
    occupancy_percent: occupancyPercent,
    // Reaching this point already proved the owner's subscription is
    // ACTIVE (see the check above) — "verified" in this phase is
    // deliberately defined as exactly that, the only real verification
    // signal that exists in the system today. Flagged as a technical
    // decision in the Phase 8 report: the phase spec asks for a
    // "verified badge" without defining what verifies a building, and
    // there's no separate building-verification workflow anywhere else
    // in the codebase to reuse.
    verified: true,
  };
}

/**
 * Phase 8 addition: total buildings currently eligible for the public
 * directory — the "total verified/subscribed buildings" transparency
 * counter (implementation step 5). Distinct from countAllBuildings()
 * above, which counts every building regardless of its owner's
 * subscription status.
 */
async function countPublicBuildings() {
  const activeOwnerIds = await subscriptionService.getActiveOwnerIds();
  if (activeOwnerIds.length === 0) return 0;
  return buildingRepository.countPublic({ ownerIds: activeOwnerIds });
}

module.exports = {
  createBuilding,
  listBuildingsForOwner,
  getBuildingById,
  getBuildingWithStructure,
  updateBuilding,
  deleteBuilding,
  getBuildingOccupancy,
  setUtilitiesIncludedInRent,
  countAllBuildings,
  countBuildingsByOwnerIds,
  listPublicBuildings,
  getPublicBuildingDetail,
  countPublicBuildings,
};
