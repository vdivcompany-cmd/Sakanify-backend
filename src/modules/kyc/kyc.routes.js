/**
 * kyc.routes.js
 *
 * KYC endpoints beyond initial submission (which happens via
 * POST /api/students/register — see student.routes.js).
 */

const express = require('express');
const kycController = require('./kyc.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');
const { upload } = require('../../shared/utils/file-upload.util');

const router = express.Router();

const kycFileFields = upload.fields([
  { name: 'national_id_photo', maxCount: 1 },
  { name: 'student_photo', maxCount: 1 },
]);

/**
 * GET /api/kyc/me
 * Protected (student role).
 */
router.get('/me', verifyToken, requireRole(ROLES.STUDENT), kycController.getMyKyc);

/**
 * POST /api/kyc/me/resubmit
 * Protected (student role). Only works while status is "rejected".
 */
router.post(
  '/me/resubmit',
  verifyToken,
  requireRole(ROLES.STUDENT),
  kycFileFields,
  kycController.resubmitKyc,
);

/**
 * PATCH /api/kyc/:kycId/status
 * Super-admin only in this phase — see kyc.service.updateVerificationStatus
 * for why owner access is deferred to Phase 4.
 * Body: { status: 'verified' | 'rejected' }
 */
router.patch(
  '/:kycId/status',
  verifyToken,
  requireRole(ROLES.SUPER_ADMIN),
  kycController.updateVerificationStatus,
);

module.exports = router;
