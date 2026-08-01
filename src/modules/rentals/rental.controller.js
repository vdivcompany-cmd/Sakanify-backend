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
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
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
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
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
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
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
    return error(res, { statusCode: err.statusCode || 400, message: err.message });
  }
}

module.exports = {
  listRentals,
  getRental,
  markVacating,
  finalizeMoveOut,
};
