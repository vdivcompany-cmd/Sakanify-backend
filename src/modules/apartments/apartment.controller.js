/**
 * apartment.controller.js
 *
 * Owner-facing apartment CRUD, nested under a building for
 * creation/listing (POST/GET /api/buildings/:buildingId/apartments) and
 * addressed directly by id for get/update/delete
 * (/api/apartments/:apartmentId). Ownership is always checked against the
 * apartment's own (denormalized) owner_id — see apartment.model.js for
 * why that's safe — never by re-fetching the parent building.
 */

const { success, error } = require('../../shared/utils/response.util');
const buildingService = require('../buildings/building.service');
const apartmentService = require('./apartment.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');

function validateApartmentFields(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (!partial || body.floor !== undefined) {
    const floor = Number(body.floor);
    if (body.floor === undefined || Number.isNaN(floor) || floor < 0) {
      errors.push('floor must be a non-negative number');
    } else {
      data.floor = floor;
    }
  }

  if (!partial || body.room_count !== undefined) {
    const roomCount = Number(body.room_count);
    if (body.room_count === undefined || !Number.isInteger(roomCount) || roomCount < 1) {
      errors.push('room_count must be an integer >= 1');
    } else {
      data.room_count = roomCount;
    }
  }

  return { data, errors };
}

/**
 * POST /api/buildings/:buildingId/apartments
 * Owner only. Building ownership is verified before creating.
 */
async function createApartment(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { data, errors } = validateApartmentFields(req.body);
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }

    const apartment = await apartmentService.createApartment(building._id, building.owner_id, data);
    return success(res, { statusCode: 201, message: 'Apartment created', data: apartment });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * GET /api/buildings/:buildingId/apartments
 * Owner only, paginated.
 */
async function listApartments(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { apartments, total } = await apartmentService.listApartmentsForBuilding(building._id, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Apartments retrieved',
      data: apartments,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/apartments/:apartmentId
 * Owner only, ownership-scoped via the apartment's own owner_id. Returns
 * the apartment with its beds.
 */
async function getApartment(req, res) {
  try {
    const { apartment, beds } = await apartmentService.getApartmentWithBeds(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    return success(res, {
      statusCode: 200,
      message: 'Apartment retrieved',
      data: { ...apartment.toObject(), beds },
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * PATCH /api/apartments/:apartmentId
 * Owner only, ownership-scoped.
 */
async function updateApartment(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { data, errors } = validateApartmentFields(req.body, { partial: true });
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }
    if (Object.keys(data).length === 0) {
      return error(res, { statusCode: 422, message: 'No valid fields provided to update' });
    }

    const updated = await apartmentService.updateApartment(req.params.apartmentId, data);
    return success(res, { statusCode: 200, message: 'Apartment updated', data: updated });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * DELETE /api/apartments/:apartmentId
 * Owner only, ownership-scoped. Blocked while beds still exist under it.
 */
async function deleteApartment(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    await apartmentService.deleteApartment(req.params.apartmentId);
    return success(res, { statusCode: 200, message: 'Apartment deleted', data: null });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

module.exports = {
  createApartment,
  listApartments,
  getApartment,
  updateApartment,
  deleteApartment,
};
