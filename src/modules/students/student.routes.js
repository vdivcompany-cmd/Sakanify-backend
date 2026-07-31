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
 * Docs/phase-2-students-kyc.md Implementation Step 8 is deliberately NOT
 * built in this phase — see the Phase 2 report for the reasoning
 * (Buildings/Rentals, which the relationship would be scoped through,
 * don't exist until Phase 3/4).
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

module.exports = router;
