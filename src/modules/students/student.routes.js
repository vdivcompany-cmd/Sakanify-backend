/**
 * student.routes.js
 *
 * Student profile endpoints. All routes require an authenticated student
 * (verifyToken + requireRole(STUDENT)) — students only manage their own
 * profile via req.user.userId, never by id param, so there is no
 * ownership-scoping gap to worry about here (unlike owner-facing
 * endpoints).
 *
 * The owner-facing "view a student's profile + KYC" endpoint described in
 * Docs/phase-2-students-kyc.md Implementation Step 8 was deferred out of
 * Phase 2 (Buildings/Rentals didn't exist yet to scope it through) and is
 * now built below, in Phase 4 (Docs/phase-4-booking-engine.md step 10) —
 * owner-only, relationship-scoped via request/rental data, not the
 * student's own userId.
 */

const express = require('express');
const studentController = require('./student.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');
const { upload } = require('../../shared/utils/file-upload.util');

const router = express.Router();

const kycFileFields = upload.fields([
  { name: 'national_id_photo', maxCount: 1 },
  { name: 'student_photo', maxCount: 1 },
]);

/**
 * POST /api/students/register
 * Creates the student profile + initial KYC record together.
 */
router.post(
  '/register',
  verifyToken,
  requireRole(ROLES.STUDENT),
  kycFileFields,
  studentController.registerStudent,
);

/**
 * GET /api/students/me
 */
router.get('/me', verifyToken, requireRole(ROLES.STUDENT), studentController.getMyProfile);

/**
 * PATCH /api/students/me
 */
router.patch('/me', verifyToken, requireRole(ROLES.STUDENT), studentController.updateMyProfile);

/**
 * GET /api/students/:studentId/full-profile
 * Owner only. Relationship-scoped (pending request OR active/vacating
 * rental with the requesting owner) — see student.controller.getFullProfileForOwner.
 */
router.get(
  '/:studentId/full-profile',
  verifyToken,
  requireRole(ROLES.OWNER),
  studentController.getFullProfileForOwner,
);

module.exports = router;
