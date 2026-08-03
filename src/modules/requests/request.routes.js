/**
 * request.routes.js
 *
 * Student-facing (create, list own) and owner-facing (pending queue,
 * confirm, reject) request endpoints, split by role via requireRole per
 * route rather than one blanket router-level role check (unlike
 * buildings/apartments/beds, which are owner-only end to end).
 */

const express = require('express');
const requestController = require('./request.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken);

/**
 * POST /api/requests
 * Student only.
 */
router.post('/', requireRole(ROLES.STUDENT), requestController.createRequest);

/**
 * GET /api/requests/me
 * Student only, paginated.
 */
router.get('/me', requireRole(ROLES.STUDENT), requestController.getMyRequests);

/**
 * GET /api/requests/pending
 * Owner only, paginated.
 */
router.get('/pending', requireRole(ROLES.OWNER), requestController.listPending);

/**
 * POST /api/requests/:requestId/confirm
 * Owner only, ownership-scoped.
 */
router.post('/:requestId/confirm', requireRole(ROLES.OWNER), requestController.confirmRequest);

/**
 * POST /api/requests/:requestId/reject
 * Owner only, ownership-scoped.
 */
router.post('/:requestId/reject', requireRole(ROLES.OWNER), requestController.rejectRequest);

/**
 * POST /api/requests/:requestId/appointment-date
 * Owner only, ownership-scoped (Phase 9, Part A, Product Decision 6).
 */
router.post('/:requestId/appointment-date', requireRole(ROLES.OWNER), requestController.setAppointmentDate);

module.exports = router;
