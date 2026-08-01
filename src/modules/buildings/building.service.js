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

module.exports = {
  createBuilding,
  listBuildingsForOwner,
  getBuildingById,
  getBuildingWithStructure,
  updateBuilding,
  deleteBuilding,
  getBuildingOccupancy,
  setUtilitiesIncludedInRent,
};
