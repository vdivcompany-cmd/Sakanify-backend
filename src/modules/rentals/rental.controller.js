/**
 * rental.controller.js
 *
 * Owner-facing rental list/detail + move-out actions. Rentals are never
 * created directly through this controller — creation is internal,
 * triggered by request.controller.confirmRequest (via
 * rental.service.createRentalFromRequest), matching the phase spec's
 * folder comment ("Confirm rental (internal, triggered by request
 * confirmation)").
 */

const { success, error } = require('../../shared/utils/response.util');
const rentalService = require('./rental.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

// Same reasoning as request.controller.handleControllerError: the old
// `err.statusCode || 400` catch pattern silently collapsed every
// non-AppError into an undiagnosable 400 with nothing logged anywhere
// request-logger.middleware could capture (it only logs method/path/
// status/time, never the body/error). This reuses the same
// normalizeError classification the global error handler applies, and
// logs the raw error for anything that isn't an expected AppError.
function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[rental.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/rentals
 * Owner only, paginated.
 */
async function listRentals(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { rentals, total } = await rentalService.listRentalsForOwner(req.user.ownerId, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Rentals retrieved',
      data: rentals,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listRentals');
  }
}

/**
 * GET /api/rentals/:rentalId
 * Owner only, ownership-scoped.
 */
async function getRental(req, res) {
  try {
    const rental = await rentalService.getRentalById(req.params.rentalId);

    try {
      ownershipScoping(req.user.ownerId, rental.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    return success(res, { statusCode: 200, message: 'Rental retrieved', data: rental });
  } catch (err) {
    return handleControllerError(res, err, 'getRental');
  }
}

/**
 * POST /api/rentals/:rentalId/vacate
 * Owner only, ownership-scoped. Marks the rental as vacating — the bed
 * stays occupied (see rental.service.markVacating).
 */
async function markVacating(req, res) {
  try {
    const rental = await rentalService.getRentalById(req.params.rentalId);

    try {
      ownershipScoping(req.user.ownerId, rental.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const updated = await rentalService.markVacating(req.params.rentalId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Rental marked as vacating', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'markVacating');
  }
}

/**
 * POST /api/rentals/:rentalId/finalize-move-out
 * Owner only, ownership-scoped. Bed occupied -> available, rental closed.
 */
async function finalizeMoveOut(req, res) {
  try {
    const rental = await rentalService.getRentalById(req.params.rentalId);

    try {
      ownershipScoping(req.user.ownerId, rental.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const updated = await rentalService.finalizeMoveOut(req.params.rentalId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Move-out finalized — bed released', data: updated });
  } catch (err) {
    return handleControllerError(res, err, 'finalizeMoveOut');
  }
}

module.exports = {
  listRentals,
  getRental,
  markVacating,
  finalizeMoveOut,
};
