/**
 * rental.routes.js
 *
 * Owner-only rental list/detail + move-out actions. No POST / (create) —
 * rentals are only ever created internally via
 * request.service.confirmRequest, never directly through this router.
 */

const express = require('express');
const rentalController = require('./rental.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.get('/', rentalController.listRentals);
router.get('/:rentalId', rentalController.getRental);
router.post('/:rentalId/vacate', rentalController.markVacating);
router.post('/:rentalId/finalize-move-out', rentalController.finalizeMoveOut);

module.exports = router;
