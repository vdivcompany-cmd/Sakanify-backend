/**
 * building.routes.js
 *
 * Owner-only building endpoints, ownership-scoped in every controller
 * action (see building.controller.js). Apartment creation/listing for a
 * given building is mounted here too (nested under /:buildingId), since
 * REST-wise an apartment only ever exists in the context of a building.
 */

const express = require('express');
const buildingController = require('./building.controller');
const apartmentController = require('../apartments/apartment.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.post('/', buildingController.createBuilding);
router.get('/', buildingController.listBuildings);
router.get('/:buildingId', buildingController.getBuilding);
router.patch('/:buildingId', buildingController.updateBuilding);
router.delete('/:buildingId', buildingController.deleteBuilding);
router.get('/:buildingId/occupancy', buildingController.getOccupancy);
router.patch('/:buildingId/utilities-setting', buildingController.updateUtilitiesSetting);

// --- Apartments nested under a building ---
router.post('/:buildingId/apartments', apartmentController.createApartment);
router.get('/:buildingId/apartments', apartmentController.listApartments);

module.exports = router;
