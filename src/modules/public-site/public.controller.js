/**
 * public.controller.js
 *
 * The first fully unauthenticated surface in the backend (buildings
 * list/detail, transparency counters, lead submission), plus a small
 * owner-facing, authenticated slice (list/view their own public leads).
 *
 * Every catch block runs errors through normalizeError()
 * (error-handler.middleware) per CLAUDE.md Section 7.3a, same pattern as
 * request.controller.js's handleControllerError — an unclassified error
 * here must never collapse into a generic status code, and anything that
 * isn't an expected AppError is console.error()'d so the real
 * message/stack is visible in logs.
 */

const { success, error } = require('../../shared/utils/response.util');
const publicService = require('./public.service');
const { parsePagination, buildMeta } = require('../../shared/utils/pagination.util');
const { ownershipScoping } = require('../../middleware/auth.middleware');
const { AppError, normalizeError } = require('../../middleware/error-handler.middleware');

function handleControllerError(res, err, context) {
  if (!(err instanceof AppError)) {
    console.error(`[public.controller:${context}]`, err);
  }
  const { statusCode, message, errors } = normalizeError(err);
  return error(res, { statusCode, message, errors });
}

/**
 * GET /api/public/buildings
 * Public, unauthenticated, paginated. Query: ?area=&page=&limit=
 */
async function listBuildings(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const area = req.query.area ? String(req.query.area).trim() : null;

    const { buildings, total } = await publicService.listBuildings({ area, skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Buildings retrieved',
      data: buildings,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listBuildings');
  }
}

/**
 * GET /api/public/buildings/:buildingId
 * Public, unauthenticated.
 */
async function getBuildingDetail(req, res) {
  try {
    const detail = await publicService.getBuildingDetail(req.params.buildingId);
    return success(res, { statusCode: 200, message: 'Building retrieved', data: detail });
  } catch (err) {
    return handleControllerError(res, err, 'getBuildingDetail');
  }
}

/**
 * GET /api/public/buildings/:buildingId/beds
 * Public, unauthenticated (Phase 9, Part A/B — the public bed-picker /
 * roommate-college-visibility endpoint).
 */
async function listBuildingBeds(req, res) {
  try {
    const beds = await publicService.listPublicBedsForBuilding(req.params.buildingId);
    return success(res, { statusCode: 200, message: 'Beds retrieved', data: beds });
  } catch (err) {
    return handleControllerError(res, err, 'listBuildingBeds');
  }
}

/**
 * POST /api/public/leads
 * Public, unauthenticated, IP rate-limited more strictly than the read
 * endpoints (see public.routes.js). Body: { name, phone, note?, bed_id }
 *
 * Returns only the lead's id/status — never echoes back the submitted
 * name/phone/note, and never a Bed or Request payload, since no Bed or
 * Request was touched.
 */
async function submitLead(req, res) {
  try {
    const { name, phone, note, bed_id: bedId } = req.body;
    const lead = await publicService.submitLead({ name, phone, note, bedId });

    return success(res, {
      statusCode: 201,
      message: "Thanks for your interest — we've passed it along to the building owner",
      data: { id: lead._id, status: lead.status },
    });
  } catch (err) {
    return handleControllerError(res, err, 'submitLead');
  }
}

/**
 * GET /api/public/counters
 * Public, unauthenticated. Non-sensitive aggregate numbers only.
 */
async function getTransparencyCounters(req, res) {
  try {
    const counters = await publicService.getTransparencyCounters();
    return success(res, { statusCode: 200, message: 'Transparency counters retrieved', data: counters });
  } catch (err) {
    return handleControllerError(res, err, 'getTransparencyCounters');
  }
}

/**
 * GET /api/public/leads/mine
 * Owner only, paginated. The authenticated owner's own public leads —
 * distinct from GET /api/requests/pending.
 */
async function listMyLeads(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const { leads, total } = await publicService.listLeadsForOwner(req.user.ownerId, { skip, limit });

    return success(res, {
      statusCode: 200,
      message: 'Public leads retrieved',
      data: leads,
      meta: buildMeta(total, page, limit),
    });
  } catch (err) {
    return handleControllerError(res, err, 'listMyLeads');
  }
}

/**
 * GET /api/public/leads/mine/:leadId
 * Owner only, ownership-scoped — same fetch-then-check pattern as every
 * other owner-facing controller since Phase 3 (CLAUDE.md Section 3.3).
 */
async function getMyLead(req, res) {
  try {
    const lead = await publicService.getLeadForOwner(req.params.leadId);

    try {
      ownershipScoping(req.user.ownerId, lead.owner_id);
    } catch (scopeErr) {
      return error(res, { statusCode: 403, message: scopeErr.message });
    }

    return success(res, { statusCode: 200, message: 'Public lead retrieved', data: lead });
  } catch (err) {
    return handleControllerError(res, err, 'getMyLead');
  }
}

module.exports = {
  listBuildings,
  getBuildingDetail,
  listBuildingBeds,
  submitLead,
  getTransparencyCounters,
  listMyLeads,
  getMyLead,
};
