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
const rentalService = require('../rentals/rental.service');
// Security-hardening-pass addition (Aug 2026, hardening-audit Category
// 9/F — "Free capacity abuse"): required in the controller, not
// bed.service, specifically to avoid a load-order cycle — subscription.
// service already requires bed.service (for countBedsForOwner, used by
// getUsageForOwner), so a reverse require from bed.service back into
// subscription.service would be circular. The controller layer has no
// such constraint. See createBed()'s capacity check below.
const subscriptionService = require('../subscriptions/subscription.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { BED_STATUS } = require('../../config/constants.config');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

// Security-hardening-pass addition (hardening-audit Category 5 / CLAUDE.md
// Section 7.3a) — bed.service only ever throws AppError, so this is a
// straightforward swap with no behavior change for the classified case.
function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[bed.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

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

  // Added in Phase 5 — see bed.model.js's monthly_rent comment.
  if (body.monthly_rent !== undefined) {
    if (typeof body.monthly_rent !== 'number' || Number.isNaN(body.monthly_rent) || body.monthly_rent < 0) {
      errors.push('monthly_rent must be a non-negative number');
    } else {
      data.monthly_rent = body.monthly_rent;
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

  // Added in Phase 5 — see bed.model.js's monthly_rent comment.
  if (body.monthly_rent !== undefined) {
    if (typeof body.monthly_rent !== 'number' || Number.isNaN(body.monthly_rent) || body.monthly_rent < 0) {
      errors.push('monthly_rent must be a non-negative number');
    } else {
      data.monthly_rent = body.monthly_rent;
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

    // Security-hardening-pass addition (Aug 2026, hardening-audit Category
    // 9/F): hard-block bed creation once it would exceed the owner's
    // subscribed bed capacity. threat-catalog.md's Category F assumed this
    // check already existed and only needed TOCTOU-hardening against
    // concurrent creation — the real gap found during this pass was
    // larger: no capacity check existed at all. Project owner's explicit
    // decision (over soft-warning + overage billing, which would require
    // billing infrastructure that doesn't exist yet): reject with a clear
    // 403 pointing at the existing Phase 6 expansion-request endpoint.
    //
    // A plain read-then-compare check, not an atomic guarantee — same
    // deliberate, documented soft-limit pattern already used for
    // MAX_PENDING_REQUESTS_PER_STUDENT in request.service.createRequest
    // (see that function's doc comment): under a genuine race between two
    // concurrent bed-creation requests for the same owner, worst case is
    // one bed created slightly over capacity, never a correctness failure
    // like bed double-booking (which IS protected by the real atomic lock
    // in bed.repository.conditionalUpdateStatus). Acceptable because a
    // capacity overshoot of one bed is a billing/plan-limits concern, not
    // a data-integrity or cross-tenant-isolation one.
    //
    // Owners with no subscription provisioned at all are treated as
    // uncapped here — mirrors subscriptionService.canAcceptNewRequests()'s
    // own established convention ("no subscription = not this function's
    // concern to gate", see that function's doc comment) — Buildings/
    // Apartments/Beds (Phase 3) predates Subscriptions (Phase 6) by
    // design, and plenty of real and test owners have buildings without
    // ever having a subscription record.
    let usage = null;
    try {
      usage = await subscriptionService.getUsageForOwner(apartment.owner_id);
    } catch (usageErr) {
      if (!(usageErr instanceof AppError) || usageErr.statusCode !== 404) {
        throw usageErr;
      }
      // No subscription found for this owner — uncapped, fall through.
    }

    if (usage && usage.beds_used >= usage.total_bed_capacity) {
      throw new AppError(
        `Cannot create bed: this would exceed your subscription's bed capacity `
          + `(${usage.beds_used}/${usage.total_bed_capacity} beds used). `
          + 'Request a capacity expansion via POST /api/subscriptions/expansion-requests before adding more beds.',
        403,
      );
    }

    const bed = await bedService.createBed(apartment._id, apartment.building, apartment.owner_id, data);
    return success(res, { statusCode: 201, message: 'Bed created', data: bed });
  } catch (err) {
    return handleControllerError(res, err, 'createBed');
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
    return handleControllerError(res, err, 'listBeds');
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
    return handleControllerError(res, err, 'getBed');
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
    return handleControllerError(res, err, 'updateBed');
  }
}

/**
 * DELETE /api/beds/:bedId
 * Owner only, ownership-scoped. Blocked while an active or vacating
 * rental exists for this bed — the authoritative signal as of Phase 4
 * (Docs/phase-4-booking-engine.md step 11: Phase 3 used
 * `bed.status !== 'available'` as a temporary proxy for "has an active
 * relationship" because Rentals didn't exist yet; now that it does, the
 * rental check runs first here, and bed.service.deleteBed's own
 * status-based check still runs afterward as a secondary safety layer —
 * it stays in place, but rental data is now the primary signal).
 */
async function deleteBed(req, res) {
  try {
    const bed = await bedService.getBedById(req.params.bedId);

    try {
      ownershipScoping(req.user.ownerId, bed.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const hasActiveRental = await rentalService.bedHasActiveRental(bed._id);
    if (hasActiveRental) {
      return error(res, {
        statusCode: 409,
        message: 'Cannot delete bed: an active or vacating rental exists for it. Finalize the move-out first.',
      });
    }

    await bedService.deleteBed(req.params.bedId);
    return success(res, { statusCode: 200, message: 'Bed deleted', data: null });
  } catch (err) {
    return handleControllerError(res, err, 'deleteBed');
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
    return handleControllerError(res, err, 'getBedHistory');
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
