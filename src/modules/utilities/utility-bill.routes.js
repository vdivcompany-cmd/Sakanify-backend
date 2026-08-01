/**
 * utility-bill.routes.js
 *
 * Owner-only utility-bill endpoints (Docs/phase-6-subscriptions.md's
 * folder comment: "Submit a bill for an apartment, list bills per
 * apartment/building"), ownership-scoped in every controller action.
 */

const express = require('express');
const utilityBillController = require('./utility-bill.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.post('/apartments/:apartmentId/bills', utilityBillController.submitBill);
router.get('/apartments/:apartmentId/bills', utilityBillController.listForApartment);
router.get('/buildings/:buildingId/bills', utilityBillController.listForBuilding);

module.exports = router;
