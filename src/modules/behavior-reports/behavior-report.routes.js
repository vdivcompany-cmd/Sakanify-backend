/**
 * behavior-report.routes.js
 *
 * Owner-only, authenticated (Phase 9, Part C) — not a public surface, so
 * no dedicated IP rate limiter beyond app.entry.js's global limiter, same
 * as every other authenticated-only module (buildings/apartments/beds).
 */

const express = require('express');
const behaviorReportController = require('./behavior-report.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken);
router.use(requireRole(ROLES.OWNER));

/**
 * GET /api/behavior-reports/search?national_id=...
 * Relationship-gated (Part C, Product Decision 2).
 */
router.get('/search', behaviorReportController.search);

/**
 * POST /api/behavior-reports
 * Relationship-gated at creation too (Part C, implementation step 1).
 */
router.post('/', behaviorReportController.fileReport);

module.exports = router;
