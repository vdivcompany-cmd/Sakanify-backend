/**
 * pagination.util.js
 *
 * Shared pagination helper. Added in Phase 3 because every list endpoint
 * introduced this phase (buildings, apartments, beds, audit) needs the
 * exact same page/limit parsing + meta shape, and CLAUDE.md Section 4.2
 * requires pagination on every list endpoint from day one — duplicating
 * this logic per-module would just be four copies of the same bug
 * waiting to happen. Not one of the files explicitly listed in
 * Docs/phase-3-buildings-apartments-beds.md, but a direct consequence of
 * following its own rules; flagged as an added technical decision in the
 * Phase 3 report.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Parse page/limit query params into safe, bounded values.
 * Invalid or missing values fall back to sane defaults rather than
 * erroring — list endpoints should always return *something* paginated.
 */
function parsePagination(query = {}) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);

  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

function buildMeta(total, page, limit) {
  return {
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePagination,
  buildMeta,
};
