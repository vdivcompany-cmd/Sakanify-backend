/**
 * apartment.service.js
 *
 * Business logic for apartment CRUD under a building. Never touches the
 * Building collection directly — building ownership/existence is always
 * confirmed by the controller (via building.service) before calling in
 * here, per CLAUDE.md Section 7.2 (cross-module logic goes through
 * service calls). Delegates bed-related reads to bed.service.
 */

const apartmentRepository = require('./apartment.repository');
const bedService = require('../beds/bed.service');
const { AppError } = require('../../middleware/error-handler.middleware');

/**
 * Create an apartment under a building. `ownerId` is passed in explicitly
 * by the caller (copied from the already-verified parent building's
 * owner_id) rather than re-derived here, so this function never has to
 * reach into the Building collection itself.
 */
async function createApartment(buildingId, ownerId, data) {
  return apartmentRepository.create({
    building: buildingId,
    owner_id: ownerId,
    floor: data.floor,
    room_count: data.room_count,
  });
}

async function listApartmentsForBuilding(buildingId, { skip, limit }) {
  const [apartments, total] = await Promise.all([
    apartmentRepository.findByBuilding(buildingId, { skip, limit }),
    apartmentRepository.countByBuilding(buildingId),
  ]);
  return { apartments, total };
}

async function getApartmentById(apartmentId) {
  const apartment = await apartmentRepository.findById(apartmentId);
  if (!apartment) {
    throw new AppError('Apartment not found', 404);
  }
  return apartment;
}

/**
 * Apartment + its beds, for the apartment detail view.
 */
async function getApartmentWithBeds(apartmentId) {
  const apartment = await getApartmentById(apartmentId);
  const beds = await bedService.listAllBedsForApartments([apartment._id]);
  return { apartment, beds };
}

async function updateApartment(apartmentId, updates) {
  const apartment = await apartmentRepository.updateById(apartmentId, updates);
  if (!apartment) {
    throw new AppError('Apartment not found', 404);
  }
  return apartment;
}

/**
 * Block deletion of an apartment that still has beds under it —
 * implementation step 8 ("test hierarchy integrity: ... block deletion
 * ..."). An apartment with zero beds is safe to delete outright.
 */
async function deleteApartment(apartmentId) {
  await getApartmentById(apartmentId); // 404 if missing

  const bedCount = await bedService.countBedsForApartment(apartmentId);

  if (bedCount > 0) {
    throw new AppError(
      `Cannot delete apartment: ${bedCount} bed(s) still exist under it. Delete or reassign its beds first.`,
      409,
    );
  }

  await apartmentRepository.deleteById(apartmentId);
}

/**
 * All apartments for a building, unpaginated — used only by
 * building.service's nested structure read (bounded: one building's
 * apartment count, not the whole table).
 */
async function listAllApartmentsForBuilding(buildingId) {
  return apartmentRepository.findAllByBuilding(buildingId);
}

module.exports = {
  createApartment,
  listApartmentsForBuilding,
  getApartmentById,
  getApartmentWithBeds,
  updateApartment,
  deleteApartment,
  listAllApartmentsForBuilding,
};
