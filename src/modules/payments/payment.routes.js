/**
 * payment.routes.js
 *
 * Owner-only payment status/history/confirm endpoints. No POST / (create)
 * — payments are only ever created internally via
 * rental.service.createRentalFromRequest (first period) and
 * payment-rollover.job (subsequent periods), never directly through this
 * router (same pattern as rental.routes.js).
 *
 * /overdue is registered before /:paymentId so it's never captured as an
 * id param.
 */

const express = require('express');
const paymentController = require('./payment.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.get('/', paymentController.listPayments);
router.get('/overdue', paymentController.listOverdue);
router.get('/:paymentId', paymentController.getPayment);
router.post('/:paymentId/confirm', paymentController.confirmPayment);

module.exports = router;
