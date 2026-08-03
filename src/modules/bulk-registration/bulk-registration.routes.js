/**
 * bulk-registration.routes.js
 *
 * Phase 9, Part D. One public, unauthenticated write endpoint (submit via
 * link) — rate-limited by IP here (standard) AND by the link token itself
 * inside bulk-registration.service (Product Decision 4), same two-layer
 * pattern public.routes.js uses for lead submission. Everything else is
 * owner-only, authenticated.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('../../shared/utils/redis-rate-limit-store');
const { upload } = require('../../shared/utils/file-upload.util');
const bulkRegistrationController = require('./bulk-registration.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

const kycFileFields = upload.fields([
  { name: 'national_id_photo', maxCount: 1 },
  { name: 'student_photo', maxCount: 1 },
]);

const submitStore = createRateLimitStore('bulk-submit:');
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many submissions from this connection. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: submitStore,
});

// --- Public, unauthenticated ---
router.post('/submit/:token', submitLimiter, kycFileFields, bulkRegistrationController.submitViaLink);

// --- Owner-facing, authenticated ---
router.use(verifyToken, requireRole(ROLES.OWNER));

router.post('/buildings/:buildingId/links', bulkRegistrationController.generateLink);
router.delete('/buildings/:buildingId/links', bulkRegistrationController.revokeLink);
router.post('/buildings/:buildingId/manual-entry', kycFileFields, bulkRegistrationController.manualEntry);
router.get('/submissions/pending', bulkRegistrationController.listPending);
router.post('/submissions/:submissionId/assign', bulkRegistrationController.assignToBed);
router.post('/submissions/:submissionId/reject', bulkRegistrationController.rejectSubmission);

// Test-only escape hatch, same pattern as public.routes.js.
router.rateLimitStores = { submit: submitStore };

module.exports = router;
