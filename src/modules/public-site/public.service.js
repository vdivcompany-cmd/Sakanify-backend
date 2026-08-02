/**
 * public.service.js
 *
 * Business logic for the public-facing directory API. Delegates entirely
 * to the owning modules' own services — buildingService for the
 * subscribed-only listing/detail/counter logic, kycService for the
 * verified-students counter, publicLeadService for lead capture — never
 * touching another module's collection directly (CLAUDE.md Section 7.2).
 * This file's only job is to compose those calls into the shapes the
 * public-site controller needs.
 */

const buildingService = require('../buildings/building.service');
const kycService = require('../kyc/kyc.service');
const publicLeadService = require('./public-lead.service');

/**
 * Implementation steps 1-2: subscribed-only building listing, optional
 * area filter.
 */
async function listBuildings({ area, skip, limit }) {
  return buildingService.listPublicBuildings({ area, skip, limit });
}

/**
 * Implementation step 3: single building detail (occupancy percentage +
 * verified badge, no bed-by-bed breakdown).
 */
async function getBuildingDetail(buildingId) {
  return buildingService.getPublicBuildingDetail(buildingId);
}

/**
 * Implementation step 4: submit a public lead. See
 * public-lead.service.createLead's doc comment for why this never
 * touches bed status or the requests module.
 */
async function submitLead({ name, phone, note, bedId }) {
  return publicLeadService.createLead({ name, phone, note, bedId });
}

/**
 * Implementation step 5: public transparency counters — non-sensitive
 * aggregate numbers only. Both underlying counts are already single
 * aggregation/distinct queries in their owning modules (no N+1 here).
 * Not cached in this phase (see this function's doc note in
 * Docs/phase-8-public-site.md, implementation step 5) — a short TTL
 * cache is called out there as a reasonable *future* optimization if
 * traffic ever makes recomputing this on every request a real load
 * concern; nothing here is structured in a way that would make adding
 * that cache harder later (this function has no side effects and is
 * trivially memoizable by whoever wires a cache in front of it).
 */
async function getTransparencyCounters() {
  const [totalVerifiedBuildings, totalVerifiedStudents] = await Promise.all([
    buildingService.countPublicBuildings(),
    kycService.countVerifiedStudents(),
  ]);

  return {
    total_verified_buildings: totalVerifiedBuildings,
    total_verified_students: totalVerifiedStudents,
  };
}

/**
 * Owner-facing: their own public leads, distinct from their Pending
 * Requests queue. Ownership scoping itself happens by the controller
 * always passing req.user.ownerId as `ownerId` here — never a
 * client-supplied value.
 */
async function listLeadsForOwner(ownerId, { skip, limit }) {
  return publicLeadService.listLeadsForOwner(ownerId, { skip, limit });
}

async function getLeadForOwner(leadId) {
  return publicLeadService.getLeadById(leadId);
}

module.exports = {
  listBuildings,
  getBuildingDetail,
  submitLead,
  getTransparencyCounters,
  listLeadsForOwner,
  getLeadForOwner,
};
