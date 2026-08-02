/**
 * admin.routes.js
 *
 * Every route in this module is Super-Admin only (implementation step 8:
 * "every endpoint here must be Super-Admin only — verify explicitly,
 * since a leak exposes all owners' and students' data"). requireRole is
 * applied once via router.use, same pattern as subscription.routes.js's
 * requireRole(OWNER) — no route below can accidentally skip it.
 */

const express = require('express');
const adminController = require('./admin.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.SUPER_ADMIN));

// --- Step 1: Owners/Buildings table ---
router.get('/owners', adminController.listOwners);

// --- Step 2 / point 3: Manual Capacity Override ---
router.patch('/owners/:ownerId/capacity-override', adminController.overrideCapacity);

// --- Step 3 / points 1-2: Suspend Account ---
router.post('/owners/:ownerId/suspend', adminController.suspendOwner);

// --- Reactivate Account (added after Phase 7 report review, by explicit
// request — reverses suspendOwner's subscription/User status changes) ---
router.post('/owners/:ownerId/reactivate', adminController.reactivateOwner);

// --- Step 4 / point 4: Impersonate Owner ---
router.post('/owners/:ownerId/impersonate', adminController.impersonateOwner);
router.post('/impersonate/:jti/end', adminController.endImpersonation);

// --- Step 5: Expansion Queue ---
router.get('/expansion-requests', adminController.listExpansionRequests);
router.post('/expansion-requests/:subscriptionId/:expansionRequestId/approve', adminController.approveExpansionRequest);
router.post('/expansion-requests/:subscriptionId/:expansionRequestId/reject', adminController.rejectExpansionRequest);

// --- Step 6: Platform-wide activity feed ---
router.get('/activity', adminController.getActivityFeed);

// --- Step 7: Platform-wide metrics ---
router.get('/metrics', adminController.getPlatformMetrics);

module.exports = router;
