/**
 * bed.routes.js
 *
 * Owner-only, direct-by-id bed endpoints (get/update/delete/history).
 * Creation and per-apartment listing are mounted under
 * /api/apartments/:apartmentId/beds instead — see apartment.routes.js.
 */

const express = require('express');
const bedController = require('./bed.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.get('/:bedId', bedController.getBed);
router.patch('/:bedId', bedController.updateBed);
router.delete('/:bedId', bedController.deleteBed);
router.get('/:bedId/history', bedController.getBedHistory);

module.exports = router;
