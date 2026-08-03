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
// Phase 9 additions (Part A "public bed-picker" + Part B "roommate college
// visibility") — composed here rather than in building.service, since this
// is specifically the public-site's own read-shape, distinct from
// building.service.getPublicBuildingDetail's building-level summary.
const bedService = require('../beds/bed.service');
const rentalService = require('../rentals/rental.service');
const studentService = require('../students/student.service');
const subscriptionService = require('../subscriptions/subscription.service');
const { BED_STATUS } = require('../../config/constants.config');
const { AppError } = require('../../middleware/error-handler.middleware');

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

/**
 * Phase 9 addition (Part A implementation step 3 / Part B): the public
 * "pick your bed" list for a single building — reused by BOTH the
 * viewing-booking student-facing bed picker AND the roommate-college
 * visibility feature, per the project owner's explicit confirmation of
 * this exact field shape (id+room_label+monthly_rent for available beds,
 * id+current_occupant_college for occupied ones — nothing more, in either
 * case). Reuses building.service's existing public-eligibility gate
 * (subscriptionService.isOwnerPubliclyListed) and returns a 404 —
 * deliberately indistinguishable from "building doesn't exist" — for a
 * building whose owner isn't currently publicly listed, same existence-
 * leakage discipline as getPublicBuildingDetail.
 *
 * A bed under maintenance is excluded entirely from this public surface
 * (neither "available" nor a real occupant to show a college for) —
 * consistent with Phase 8's original no-exact-availability-map spirit for
 * every status except the two this phase's product decisions explicitly
 * carve out.
 */
async function listPublicBedsForBuilding(buildingId) {
  const building = await buildingService.getBuildingById(buildingId); // 404 if missing at all

  const isPubliclyListed = await subscriptionService.isOwnerPubliclyListed(building.owner_id);
  if (!isPubliclyListed) {
    throw new AppError('Building not found', 404);
  }

  const beds = await bedService.listAllBedsForBuilding(building._id);
  const availableBeds = beds.filter((bed) => bed.status === BED_STATUS.AVAILABLE);
  const occupiedBeds = beds.filter((bed) => bed.status === BED_STATUS.OCCUPIED);

  const occupiedBedIds = occupiedBeds.map((bed) => bed._id);
  const rentals = await rentalService.listActiveOrVacatingRentalsForBeds(occupiedBedIds);
  const rentalByBed = new Map(rentals.map((rental) => [rental.bed.toString(), rental]));

  const studentIds = rentals.map((rental) => rental.student);
  const collegeByStudent = await studentService.getCollegesForStudentIds(studentIds);

  const availableList = availableBeds.map((bed) => ({
    id: bed._id,
    status: 'available',
    room_label: bed.room_label,
    monthly_rent: bed.monthly_rent,
  }));

  const occupiedList = occupiedBeds.map((bed) => {
    const rental = rentalByBed.get(bed._id.toString());
    const college = rental ? collegeByStudent.get(rental.student.toString()) : null;
    return {
      id: bed._id,
      status: 'occupied',
      current_occupant_college: college || null,
    };
  });

  return [...availableList, ...occupiedList];
}

module.exports = {
  listBuildings,
  getBuildingDetail,
  listPublicBedsForBuilding,
  submitLead,
  getTransparencyCounters,
  listLeadsForOwner,
  getLeadForOwner,
};
