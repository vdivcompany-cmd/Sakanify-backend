/**
 * utility-bill.controller.js
 *
 * Owner-facing endpoints for the optional utility-bill-splitting feature:
 * submit a bill for an apartment, list bills per apartment or per
 * building (Docs/phase-6-subscriptions.md's folder comment). Every action
 * fetches the target apartment/building first, then calls
 * ownershipScoping(req.user.ownerId, resource.owner_id) before doing
 * anything else — same mandatory pattern as building.controller.js
 * (CLAUDE.md Section 3.3).
 *
 * Every catch block runs the error through normalizeError() and logs
 * anything that isn't an expected AppError, per CLAUDE.md Section 7.3a.
 */

const { success, error } = require('../../shared/utils/response.util');
const utilityBillService = require('./utility-bill.service');
const apartmentService = require('../apartments/apartment.service');
const buildingService = require('../buildings/building.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');
const { UTILITY_BILL_TYPE } = require('../../config/constants.config');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[utility-bill.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

function validateBillFields(body) {
  const errors = [];

  if (!body.bill_type || !Object.values(UTILITY_BILL_TYPE).includes(body.bill_type)) {
    errors.push(`bill_type must be one of: ${Object.values(UTILITY_BILL_TYPE).join(', ')}`);
  }

  if (!body.billing_period || typeof body.billing_period !== 'string' || !/^\d{4}-\d{2}$/.test(body.billing_period)) {
    errors.push('billing_period is required and must match "YYYY-MM"');
  }

  if (typeof body.total_amount !== 'number' || Number.isNaN(body.total_amount) || body.total_amount <= 0) {
    errors.push('total_amount is required and must be a positive number');
  }

  return errors;
}

/**
 * POST /api/utilities/apartments/:apartmentId/bills
 * Owner only, ownership-scoped.
 */
async function submitBill(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const errors = validateBillFields(req.body || {});
    if (errors.length > 0) {
      return error(res, { statusCode: 422, message: 'Validation failed', errors });
    }

    const bill = await utilityBillService.submitBill(
      apartment,
      {
        billType: req.body.bill_type,
        billingPeriod: req.body.billing_period,
        totalAmount: req.body.total_amount,
      },
      req.user.userId,
    );

    return success(res, { statusCode: 201, message: 'Utility bill submitted and split', data: bill });
  } catch (err) {
    return handleControllerError(res, err, 'submitBill');
  }
}

/**
 * GET /api/utilities/apartments/:apartmentId/bills
 * Owner only, ownership-scoped, paginated.
 */
async function listForApartment(req, res) {
  try {
    const apartment = await apartmentService.getApartmentById(req.params.apartmentId);

    try {
      ownershipScoping(req.user.ownerId, apartment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { bills, total } = await utilityBillService.listBillsForApartment(req.user.ownerId, apartment._id, {
      skip,
      limit,
    });

    return success(res, {
      statusCode: 200,
      message: 'Utility bills retrieved',
      data: bills,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listForApartment');
  }
}

/**
 * GET /api/utilities/buildings/:buildingId/bills
 * Owner only, ownership-scoped, paginated.
 */
async function listForBuilding(req, res) {
  try {
    const building = await buildingService.getBuildingById(req.params.buildingId);

    try {
      ownershipScoping(req.user.ownerId, building.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const { page, limit, skip } = parsePagination(req.query);
    const { bills, total } = await utilityBillService.listBillsForBuilding(req.user.ownerId, building._id, {
      skip,
      limit,
    });

    return success(res, {
      statusCode: 200,
      message: 'Utility bills retrieved',
      data: bills,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listForBuilding');
  }
}

module.exports = {
  submitBill,
  listForApartment,
  listForBuilding,
};
