/**
 * payment.controller.js
 *
 * Owner-facing cash-payment endpoints: confirm cash receipt, view
 * status/history (filterable by student/building/rental/status), and the
 * dedicated overdue-accounts view (phase spec step 8). Payments are never
 * created directly through this controller — creation is internal,
 * triggered by rental.service.createRentalFromRequest (first period) and
 * payment-rollover.job (subsequent periods), matching the phase spec's
 * folder comment.
 *
 * Every catch block runs the error through normalizeError() and logs
 * anything that isn't an expected AppError, per CLAUDE.md Section 7.3a —
 * applied from the start in this module, not retrofitted (the defect that
 * rule documents was found and fixed in Phase 4, not repeated here).
 */

const { success, error } = require('../../shared/utils/response.util');
const paymentService = require('./payment.service');
const receiptService = require('./receipt.service');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');
const { PAYMENT_STATUS } = require('../../config/constants.config');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[payment.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

function parseListFilters(query) {
  const filters = {};
  if (query.student) filters.student = query.student;
  if (query.building) filters.building = query.building;
  if (query.rental) filters.rental = query.rental;
  if (query.status) {
    if (!Object.values(PAYMENT_STATUS).includes(query.status)) {
      throw new AppError(`status must be one of: ${Object.values(PAYMENT_STATUS).join(', ')}`, 422);
    }
    filters.status = query.status;
  }
  return filters;
}

/**
 * GET /api/payments
 * Owner only, paginated, filterable (student/building/rental/status).
 */
async function listPayments(req, res) {
  try {
    const filters = parseListFilters(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const { payments, total } = await paymentService.listPaymentsForOwner(req.user.ownerId, filters, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Payments retrieved',
      data: payments,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listPayments');
  }
}

/**
 * GET /api/payments/overdue
 * Owner only, paginated — the overdue-accounts view (phase spec step 8).
 * Mounted before /:paymentId so "overdue" is never captured as an id.
 */
async function listOverdue(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { payments, total } = await paymentService.listOverdueForOwner(req.user.ownerId, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Overdue payments retrieved',
      data: payments,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listOverdue');
  }
}

/**
 * GET /api/payments/:paymentId
 * Owner only, ownership-scoped.
 */
async function getPayment(req, res) {
  try {
    const payment = await paymentService.getPaymentById(req.params.paymentId);

    try {
      ownershipScoping(req.user.ownerId, payment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    return success(res, { statusCode: 200, message: 'Payment retrieved', data: payment });
  } catch (err) {
    return handleControllerError(res, err, 'getPayment');
  }
}

/**
 * POST /api/payments/:paymentId/confirm
 * Owner only, ownership-scoped. Confirms cash received in person for this
 * billing period (full or partial — see payment.service.confirmPayment)
 * and returns a digital receipt alongside the updated payment record
 * (phase spec step 7).
 *
 * Body: { amount_paid?: number } — omitted/null settles the full
 * remaining balance for the period.
 */
async function confirmPayment(req, res) {
  try {
    const payment = await paymentService.getPaymentById(req.params.paymentId);

    try {
      ownershipScoping(req.user.ownerId, payment.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    const amountPaid = req.body && req.body.amount_paid !== undefined ? req.body.amount_paid : undefined;
    const updated = await paymentService.confirmPayment(req.params.paymentId, req.user.userId, amountPaid);
    const receipt = receiptService.generateReceipt(updated);

    return success(res, {
      statusCode: 200,
      message: 'Cash payment confirmed',
      data: { payment: updated, receipt },
    });
  } catch (err) {
    return handleControllerError(res, err, 'confirmPayment');
  }
}

module.exports = {
  listPayments,
  listOverdue,
  getPayment,
  confirmPayment,
};
