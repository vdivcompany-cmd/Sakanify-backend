/**
 * bed.controller.js
 *
 * Owner-facing bed CRUD, nested under an apartment for creation/listing
 * (POST/GET /api/apartments/:apartmentId/beds) and addressed directly by
 * id for get/update/delete/history (/api/beds/:bedId). Ownership is
 * checked against the bed's own (denormalized) owner_id.
 */

const { success, error } = require('../../shared/utils/response.util');
const apartmentService = require('../apartments/apartment.service');
const bedService = require('./bed.service');
const bedHistoryService = require('./bed-history.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { BED_STATUS } = require('../../config/constants.config');

function validateCreateFields(body) {
  const errors = [];
  const data = {};

  if (body.room_label !== undefined && body.room_label !== null) {
    if (typeof body.room_label !== 'string') {
      errors.push('room_label must be a string');
    } else {
      data.room_label = body.room_label.trim();
    }
  }

  return { data, errors };
}

function validateUpdateFields(body) {
  const errors = [];
  const data = {};

  if (body.room_label !== undefined) {
    if (body.room_label !== null && typeof body.room_label !== 'string') {
      errors.push('room_label must be a string or null');
    } else {
      data.room_label = body.room_label === null ? null : body.room_label.trim();
    }
  }

  if (body.status !== undefined) {
    if (!Object.values(BED_STATUS).includes(body.status)) {
      errors.push(`status must be one of: ${Object.values(BED_STATUS).join(', ')}`);
    } else {
      data.status = body.status;
    }
  }

  return { data, errors };
}

/**
 * POST /api/apartments/:apartmentId/beds
 * Owner only. Apartment ownership is verified before creating.
 */
async function createBed(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { data, errors } = validateCreateFields(req.body);
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }

    const bed = await bedService.createBed(apartment._id, apartment.building, apartment.owner_id, data);
    return success(res, { statusCode: 201, message: 'Bed created', data: bed });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * GET /api/apartments/:apartmentId/beds
 * Owner only, paginated.
 */
async function listBeds(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { beds, total } = await bedService.listBedsForApartment(apartment._id, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Beds retrieved',
      data: beds,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/beds/:bedId
 * Owner only, ownership-scoped.
 */
async function getBed(req, res) {
  try {
    const bed = await bedService.getBedById(req.params.bedId);

    try {
      ownershipScoping(req.user.ownerId, bed.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    return success(res, { statusCode: 200, message: 'Bed retrieved', data: bed });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * PATCH /api/beds/:bedId
 * Owner only, ownership-scoped. A status change is written to the audit
 * log via bed-history.service (see bed.service.updateBed).
 */
async function updateBed(req, res) {
  try {
    const bed = await bedService.getBedById(req.params.bedId);

    try {
      ownershipScoping(req.user.ownerId, bed.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { data, errors } = validateUpdateFields(req.body);
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }
    if (Object.keys(data).length === 0) {
      return error(res, { statusCode: 422, message: 'No valid fields provided to update' });
    }

    const updated = await bedService.updateBed(req.params.bedId, data, req.user.userId);
    return success(res, { statusCode: 200, message: 'Bed updated', data: updated });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message, errors: err.errors || null });
  }
}

/**
 * DELETE /api/beds/:bedId
 * Owner only, ownership-scoped. Blocked unless the bed's status is
 * "available" (bed.service.deleteBed).
 */
async function deleteBed(req, res) {
  try {
    const bed = await bedService.getBedById(req.params.bedId);

    try {
      ownershipScoping(req.user.ownerId, bed.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    await bedService.deleteBed(req.params.bedId);
    return success(res, { statusCode: 200, message: 'Bed deleted', data: null });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

/**
 * GET /api/beds/:bedId/history
 * Owner only, ownership-scoped. Full append-only status-change history
 * for this bed, sourced from the real audit log via bed-history.service.
 */
async function getBedHistory(req, res) {
  try {
    const bed = await bedService.getBedById(req.params.bedId);

    try {
      ownershipScoping(req.user.ownerId, bed.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const history = await bedHistoryService.getHistoryForBed(bed._id);
    return success(res, { statusCode: 200, message: 'Bed history retrieved', data: history });
  } catch (err) {
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

module.exports = {
  createBed,
  listBeds,
  getBed,
  updateBed,
  deleteBed,
  getBedHistory,
};
