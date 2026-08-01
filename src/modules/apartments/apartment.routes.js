/**
 * apartment.routes.js
 *
 * Owner-only, direct-by-id apartment endpoints (get/update/delete).
 * Creation and per-building listing are mounted under
 * /api/buildings/:buildingId/apartments instead — see
 * building.routes.js — since those actions only make sense in the
 * context of a specific building. Bed creation/listing for a given
 * apartment is mounted here too, for the same nesting reason.
 */

const express = require('express');
const apartmentController = require('./apartment.controller');
const bedController = require('../beds/bed.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.get('/:apartmentId', apartmentController.getApartment);
router.patch('/:apartmentId', apartmentController.updateApartment);
router.delete('/:apartmentId', apartmentController.deleteApartment);

// --- Beds nested under an apartment ---
router.post('/:apartmentId/beds', bedController.createBed);
router.get('/:apartmentId/beds', bedController.listBeds);

module.exports = router;
