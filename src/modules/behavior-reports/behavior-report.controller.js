/**
 * behavior-report.controller.js
 *
 * Owner-only: relationship-gated National ID search and behavior-report
 * filing (Phase 9, Part C). Every catch block runs errors through
 * normalizeError() per CLAUDE.md Section 7.3a, same pattern as every
 * other controller since the security-hardening pass.
 */

const { success, error } = require('../../shared/utils/response.util');
const behaviorReportService = require('./behavior-report.service');
const { BEHAVIOR_REPORT_SEVERITY } = require('../../config/constants.config');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[behavior-report.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/behavior-reports/search?national_id=...
 * Owner only, relationship-gated.
 */
async function search(req, res) {
  try {
    const nationalId = req.query.national_id ? String(req.query.national_id).trim() : null;
    if (!nationalId) {
      return error(res, { statusCode: 422, message: 'national_id query parameter is required' });
    }

    const result = await behaviorReportService.searchByNationalId(req.user.ownerId, nationalId, req.user.userId);
    return success(res, { statusCode: 200, message: 'Student found', data: result });
  } catch (err) {
    return handleControllerError(res, err, 'search');
  }
}

/**
 * POST /api/behavior-reports
 * Owner only, relationship-gated. Body: { student_id, incident_description, severity }
 */
async function fileReport(req, res) {
  try {
    const { student_id: studentId, incident_description: incidentDescription, severity } = req.body;

    if (!studentId) {
      return error(res, { statusCode: 422, message: 'student_id is required' });
    }
    if (!severity || !Object.values(BEHAVIOR_REPORT_SEVERITY).includes(severity)) {
      return error(res, {
        statusCode: 422,
        message: `severity is required and must be one of: ${Object.values(BEHAVIOR_REPORT_SEVERITY).join(', ')}`,
      });
    }

    const report = await behaviorReportService.fileReport(
      req.user.ownerId,
      studentId,
      { incidentDescription, severity },
      req.user.userId,
    );

    return success(res, { statusCode: 201, message: 'Behavior report filed', data: report });
  } catch (err) {
    return handleControllerError(res, err, 'fileReport');
  }
}

module.exports = {
  search,
  fileReport,
};
