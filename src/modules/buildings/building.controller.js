/**
 * building.controller.js
 *
 * Owner-facing building CRUD + nested structure/occupancy reads. Every
 * action that touches an existing building fetches it first, then calls
 * ownershipScoping(req.user.ownerId, building.owner_id) before doing
 * anything else — CLAUDE.md Section 3.3: ownership scoping is mandatory,
 * enforced at the query/service level with no exceptions.
 *
 * No separate building.validation.js file (matches the folder structure
 * in Docs/phase-3-buildings-apartments-beds.md, same convention as
 * kyc.controller.js in Phase 2) — fields are validated inline here.
 */

const { success, error } = require('../../shared/utils/response.util');
const buildingService = require('./building.service');
const apartmentService = require('../apartments/apartment.service');
const bedService = require('../beds/bed.service');
const rentalService = require('../rentals/rental.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

function validateBuildingFields(body, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (!partial || body.name !== undefined) {
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      errors.push('name is required');
    } else {
      data.name = body.name.trim();
    }
  }

  if (!partial || body.area !== undefined) {
    if (!body.area || typeof body.area !== 'string' || !body.area.trim()) {
      errors.push('area is required');
    } else {
      data.area = body.area.trim();
    }
  }

  if (!partial || body.address !== undefined) {
    const address = body.address || {};
    if (!address.city || typeof address.city !== 'string' || !address.city.trim()) {
      errors.push('address.city is required');
    } else {
      data.address = {
        city: address.city.trim(),
        street: address.street ? String(address.street).trim() : null,
        details: address.details ? String(address.details).trim() : null,
      };
    }
  }

  return { data, errors };
}

/**
 * POST /api/buildings
 * Owner only.
 */
async function createBuilding(req, res) {
  try {
    const { data, errors } = validateBuildingFields(req.body);
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }

    const building = await buildingService.createBuilding(req.user.ownerId, data);
    return success(res, { statusCode: 201, message: 'Building created', data: building });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * GET /api/buildings
 * Owner only. Lists the authenticated owner's own buildings, paginated.
 */
async function listBuildings(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { buildings, total } = await buildingService.listBuildingsForOwner(req.user.ownerId, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Buildings retrieved',
      data: buildings,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/buildings/:buildingId
 * Owner only, ownership-scoped. Returns the full nested structure
 * (building -> apartments -> beds) for dashboard consumption.
 */
async function getBuilding(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const structure = await buildingService.getBuildingWithStructure(req.params.buildingId);
    return success(res, { statusCode: 200, message: 'Building retrieved', data: structure });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * PATCH /api/buildings/:buildingId
 * Owner only, ownership-scoped.
 */
async function updateBuilding(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { data, errors } = validateBuildingFields(req.body, { partial: true });
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }
    if (Object.keys(data).length === 0) {
      return error(res, { statusCode: 422, message: 'No valid fields provided to update' });
    }

    const updated = await buildingService.updateBuilding(req.params.buildingId, data);
    return success(res, { statusCode: 200, message: 'Building updated', data: updated });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * DELETE /api/buildings/:buildingId
 * Owner only, ownership-scoped. Blocked while any bed anywhere in the
 * building has an active/vacating rental (Phase 4 step 11 retrofit —
 * authoritative signal), OR while apartments still exist under it at all
 * (building.service.deleteBuilding's original Phase 3 check, kept as a
 * secondary safety layer).
 */
async function deleteBuilding(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const apartments = await apartmentService.listAllApartmentsForBuilding(building._id);
    const apartmentIds = apartments.map((apt) => apt._id);
    const beds = apartmentIds.length > 0 ? await bedService.listAllBedsForApartments(apartmentIds) : [];
    const bedIds = beds.map((bed) => bed._id);
    const hasActiveRental = await rentalService.anyBedHasActiveRental(bedIds);
    if (hasActiveRental) {
      return error(res, {
        statusCode: 409,
        message: 'Cannot delete building: one of its beds has an active or vacating rental. Finalize move-out(s) first.',
      });
    }

    await buildingService.deleteBuilding(req.params.buildingId);
    return success(res, { statusCode: 200, message: 'Building deleted', data: null });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/buildings/:buildingId/occupancy
 * Owner only, ownership-scoped.
 */
async function getOccupancy(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const occupancy = await buildingService.getBuildingOccupancy(req.params.buildingId);
    return success(res, { statusCode: 200, message: 'Occupancy retrieved', data: occupancy });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * PATCH /api/buildings/:buildingId/utilities-setting
 * Owner only, ownership-scoped. Phase 6 addition (Docs/phase-6-subscriptions.md,
 * step 7): toggle whether this building's rent already includes utilities
 * (default true — opt-in only). Uses normalizeError() per CLAUDE.md
 * Section 7.3a — applied here since this is new Phase 6 code, even though
 * the rest of this already-closed Phase 3 controller predates that rule
 * (flagged, not silently fixed elsewhere, in the Phase 6 report).
 */
async function updateUtilitiesSetting(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    if (typeof req.body.utilities_included_in_rent !== 'boolean') {
      throw new AppError('utilities_included_in_rent must be a boolean', 422);
    }

    const updated = await buildingService.setUtilitiesIncludedInRent(
      req.params.buildingId,
      req.body.utilities_included_in_rent,
      req.user.userId,
    );
    return success(res, { statusCode: 200, message: 'Utilities setting updated', data: updated });
  } catch (err) {
    if (!(err instanceof AppError)) {
      console.error('[building.controller:updateUtilitiesSetting]', err);
    }
    const { statusCode, message, errors } = normalizeError(err);
    return error(res, { statusCode, message, errors });
  }
}

module.exports = {
  createBuilding,
  listBuildings,
  getBuilding,
  updateBuilding,
  deleteBuilding,
  getOccupancy,
  updateUtilitiesSetting,
};
