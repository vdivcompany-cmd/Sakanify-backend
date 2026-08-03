/**
 * booking-engine.test.js
 *
 * Integration tests for Phase 4 (Booking Engine — Requests & Rentals).
 * Docs/phase-4-booking-engine.md calls this "the highest-risk,
 * highest-priority module in the backend" and explicitly requires a test
 * that simulates near-simultaneous requests for the same bed — that test
 * (describe block "Atomic Bed-Locking Under Concurrency" below) is the
 * single most important thing in this file (CLAUDE.md Section 4.5/6.2).
 *
 * Also covers: duplicate-request cap, confirm/reject flow, the
 * request-expiry job, rental move-out (vacating -> closed), the
 * owner-facing student full-profile view with its explicit isolation
 * test (Phase 4 step 10), the Phase 3 deletion-restriction retrofit
 * (step 11), and role-guard boundaries.
 *
 * Per project convention (Phase 1 lesson): every test uses unique data.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');

const User = require('../../src/modules/auth/auth.model');
const Building = require('../../src/modules/buildings/building.model');
const Apartment = require('../../src/modules/apartments/apartment.model');
const Bed = require('../../src/modules/beds/bed.model');
const Student = require('../../src/modules/students/student.model');
const Kyc = require('../../src/modules/kyc/kyc.model');
const RequestModel = require('../../src/modules/requests/request.model');
const Rental = require('../../src/modules/rentals/rental.model');
const Audit = require('../../src/modules/audit/audit.model');
const Subscription = require('../../src/modules/subscriptions/subscription.model');

const authService = require('../../src/modules/auth/auth.service');
const requestExpiryJob = require('../../src/modules/requests/request-expiry.job');
const subscriptionService = require('../../src/modules/subscriptions/subscription.service');
const { ROLES, BED_STATUS, REQUEST_STATUS, RENTAL_STATUS, REQUEST_REJECTION_REASON } = require('../../src/config/constants.config');

let mongoServer;
let uniqueCounter = 0;
function uniqueTag() {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}-${Math.random().toString(36).slice(2)}`;
}

async function createOwner() {
  const tag = uniqueTag();
  const ownerId = `owner-${tag}`;
  const owner = await User.create({
    email: `owner-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(owner._id.toString(), ROLES.OWNER, ownerId);
  return { owner, ownerId, token: accessToken };
}

async function createSuperAdmin() {
  const tag = uniqueTag();
  const admin = await User.create({
    email: `admin-${tag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(admin._id.toString(), ROLES.SUPER_ADMIN, null);
  return { admin, token: accessToken };
}

/** Creates a User(student) + full Student profile directly (bypassing the
 * HTTP registration flow, which is already covered by students-kyc.test.js)
 * so this file can focus on request/rental logic. */
async function createStudent() {
  const tag = uniqueTag();
  const user = await User.create({
    phone: `+2010${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    role: ROLES.STUDENT,
    status: 'active',
  });
  const student = await Student.create({
    user: user._id,
    name: `Test Student ${tag}`,
    phone: user.phone,
    college: 'Faculty of Engineering',
    academic_year: 2,
    smoking_preference: 'non_smoker',
  });
  await Kyc.create({
    student: student._id,
    national_id_number: `2990101${String(uniqueCounter).padStart(7, '0')}`,
    national_id_photo: 'kyc/fake-id.png',
    student_photo: 'kyc/fake-photo.png',
  });
  const { accessToken } = authService.issueTokens(user._id.toString(), ROLES.STUDENT, null);
  return { user, student, token: accessToken };
}

/** Building -> Apartment -> Bed(available), created directly via models
 * for speed (Buildings/Apartments/Beds CRUD itself is already covered by
 * buildings-apartments-beds.test.js). */
async function createBedFixture(ownerId, overrides = {}) {
  const building = await Building.create({
    owner_id: ownerId,
    name: `Building ${uniqueTag()}`,
    area: 'Nasr City',
    address: { city: 'Cairo', street: null, details: null },
  });
  const apartment = await Apartment.create({
    building: building._id,
    owner_id: ownerId,
    floor: 1,
    room_count: 3,
  });
  const bed = await Bed.create({
    apartment: apartment._id,
    building: building._id,
    owner_id: ownerId,
    status: BED_STATUS.AVAILABLE,
    ...overrides,
  });
  return { building, apartment, bed };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Building.deleteMany({});
  await Apartment.deleteMany({});
  await Bed.deleteMany({});
  await Student.deleteMany({});
  await Kyc.deleteMany({});
  await RequestModel.deleteMany({});
  await Rental.deleteMany({});
  await Audit.deleteMany({});
  await Subscription.deleteMany({});
});

describe('Booking Engine (Requests & Rentals) — Integration Tests', () => {
  // ========================================================================
  // Phase 9, Part A REDESIGN — the atomic bed-locking guarantee moved from
  // request-creation to confirm-time. Every test below in this describe
  // block was REWRITTEN (not just re-passed) from Phase 4's original
  // version, per the project owner's explicit instruction — the exact
  // behavior under test (a bed locks the instant a request is created) no
  // longer exists on purpose. See Docs/reports/phase-9-report.md for the
  // full list of changed tests and the reasoning.
  // ========================================================================
  describe('Non-Exclusive Creation, THEN Atomic Confirm-Time Locking (Phase 9, Part A)', () => {
    it('REWRITTEN (was: "atomic bed-locking at creation"): many near-simultaneous requests for the same bed at CREATION time should ALL succeed — creation is non-exclusive by design', async () => {
      const { ownerId } = await createOwner();
      const { bed } = await createBedFixture(ownerId);

      const CONCURRENT_STUDENTS = 10;
      const students = await Promise.all(Array.from({ length: CONCURRENT_STUDENTS }, () => createStudent()));

      const responses = await Promise.all(
        students.map(({ token }) =>
          request(app)
            .post('/api/requests')
            .set('Authorization', `Bearer ${token}`)
            .send({ bed_id: bed._id.toString() }),
        ),
      );

      const succeeded = responses.filter((r) => r.status === 201);
      expect(succeeded.length).toBe(CONCURRENT_STUDENTS);

      const requestCount = await RequestModel.countDocuments({ bed: bed._id, status: REQUEST_STATUS.PENDING });
      expect(requestCount).toBe(CONCURRENT_STUDENTS);

      // Creation must NEVER touch bed status (Part A implementation step 2,
      // explicit test requirement) — the bed stays available the whole time.
      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('NEW — THE critical deliverable (replaces Phase 4\'s creation-time concurrency test): exactly ONE of many pre-existing pending requests for the same bed can win a near-simultaneous CONFIRM race, and the rest are cleanly rejected with 409 (CLAUDE.md Section 4.5/6.2)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);

      const CONCURRENT_STUDENTS = 10;
      const students = await Promise.all(Array.from({ length: CONCURRENT_STUDENTS }, () => createStudent()));

      const createResponses = await Promise.all(
        students.map(({ token }) =>
          request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed._id.toString() }),
        ),
      );
      const requestIds = createResponses.map((r) => r.body.data._id);
      expect(requestIds.length).toBe(CONCURRENT_STUDENTS);

      // Now race the CONFIRM calls — this is where atomicity actually
      // lives as of Phase 9.
      const confirmResponses = await Promise.all(
        requestIds.map((requestId) =>
          request(app).post(`/api/requests/${requestId}/confirm`).set('Authorization', `Bearer ${ownerToken}`),
        ),
      );

      const succeeded = confirmResponses.filter((r) => r.status === 200);
      const conflicted = confirmResponses.filter((r) => r.status === 409);
      expect(succeeded.length).toBe(1);
      expect(conflicted.length).toBe(CONCURRENT_STUDENTS - 1);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.OCCUPIED);

      const rentalCount = await Rental.countDocuments({ bed: bed._id });
      expect(rentalCount).toBe(1);

      // Every OTHER pending request for this bed must now be bed_taken —
      // never left dangling as pending, never silently deleted.
      const bedTakenCount = await RequestModel.countDocuments({ bed: bed._id, status: REQUEST_STATUS.BED_TAKEN });
      expect(bedTakenCount).toBe(CONCURRENT_STUDENTS - 1);
    });

    it('NEW: confirming one request auto-marks every other pending request for the same bed as bed_taken (sequential, deterministic version of the race test above)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: winnerToken } = await createStudent();
      const { token: loserToken } = await createStudent();

      const winnerRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${winnerToken}`).send({ bed_id: bed._id.toString() });
      const loserRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${loserToken}`).send({ bed_id: bed._id.toString() });

      const confirmRes = await request(app)
        .post(`/api/requests/${winnerRes.body.data._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(confirmRes.status).toBe(200);

      const freshLoser = await RequestModel.findById(loserRes.body.data._id);
      expect(freshLoser.status).toBe(REQUEST_STATUS.BED_TAKEN);
    });

    it('NEW: a student cannot hold two pending requests for the SAME bed at once (the new {student, bed} partial unique index)', async () => {
      const { ownerId } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token } = await createStudent();

      const first = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed._id.toString() });
      expect(first.status).toBe(201);

      const second = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed._id.toString() });
      expect(second.status).toBe(409);
    });

    it('REWRITTEN (was: "reject requesting a bed that is not available"): still rejects creating a request for a genuinely occupied bed — unchanged behavior, still true under the new design', async () => {
      const { ownerId } = await createOwner();
      const { bed } = await createBedFixture(ownerId, { status: BED_STATUS.OCCUPIED });
      const { token } = await createStudent();

      const res = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ bed_id: bed._id.toString() });

      expect(res.status).toBe(409);
    });

    it('NEW: rejects confirming a request whose bed already went to another confirmed booking (the AVAILABLE->OCCUPIED guard doing its job)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: token1 } = await createStudent();
      const { token: token2 } = await createStudent();

      const res1 = await request(app).post('/api/requests').set('Authorization', `Bearer ${token1}`).send({ bed_id: bed._id.toString() });
      const res2 = await request(app).post('/api/requests').set('Authorization', `Bearer ${token2}`).send({ bed_id: bed._id.toString() });

      const confirm1 = await request(app).post(`/api/requests/${res1.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      expect(confirm1.status).toBe(200);

      // res2's request is now bed_taken (auto-marked), so confirming it
      // hits the "not pending" guard, not the bed-availability guard — but
      // either way it must fail with a conflict.
      const confirm2 = await request(app).post(`/api/requests/${res2.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      expect(confirm2.status).toBe(409);
    });
  });

  // ========================================================================
  // Phase 6 retrofit: a suspended owner's subscription blocks new requests
  // (Docs/phase-6-subscriptions.md, step 5; wired into
  // request.service.createRequest() per explicit project-owner decision
  // after the Phase 6 report — see that report's "Technical Decisions"
  // section).
  // ========================================================================
  describe('Subscription Gating (Phase 6 retrofit)', () => {
    it('should reject creating a request when the bed\'s owner has a SUSPENDED subscription, and must NOT lock the bed', async () => {
      const { ownerId } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      await subscriptionService.updateStatus(ownerId, 'suspended');

      const { bed } = await createBedFixture(ownerId);
      const { token } = await createStudent();

      const res = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ bed_id: bed._id.toString() });

      expect(res.status).toBe(403);

      // The bed must NOT have been locked — the subscription check
      // happens before the atomic bed transition, same as the
      // duplicate-request cap.
      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('should still allow creating a request when the owner has no subscription provisioned at all (guard is a no-op, not a hard requirement)', async () => {
      const { ownerId } = await createOwner();
      // No Subscription document created for this owner at all.
      const { bed } = await createBedFixture(ownerId);
      const { token } = await createStudent();

      const res = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ bed_id: bed._id.toString() });

      expect(res.status).toBe(201);
    });

    it('should allow creating a request when the owner subscription is ACTIVE (not suspended)', async () => {
      const { ownerId } = await createOwner();
      await subscriptionService.createSubscription(ownerId, {
        tierName: '10-bed package',
        totalBedCapacity: 10,
        monthlyPrice: 1000,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const { bed } = await createBedFixture(ownerId);
      const { token } = await createStudent();

      const res = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${token}`)
        .send({ bed_id: bed._id.toString() });

      expect(res.status).toBe(201);
    });
  });

  // ========================================================================
  // Duplicate-request cap
  // ========================================================================
  describe('Duplicate-Request Cap (max 2 pending per student)', () => {
    it('should allow a student 2 pending requests but reject a 3rd', async () => {
      const { ownerId } = await createOwner();
      const { bed: bed1 } = await createBedFixture(ownerId);
      const { bed: bed2 } = await createBedFixture(ownerId);
      const { bed: bed3 } = await createBedFixture(ownerId);
      const { token } = await createStudent();

      const res1 = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed1._id.toString() });
      const res2 = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed2._id.toString() });
      const res3 = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed3._id.toString() });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res3.status).toBe(409);

      // The 3rd bed must NOT have been locked — the cap check happens
      // before the atomic bed transition.
      const freshBed3 = await Bed.findById(bed3._id);
      expect(freshBed3.status).toBe(BED_STATUS.AVAILABLE);
    });
  });

  // ========================================================================
  // Confirm flow
  // ========================================================================
  describe('Confirm Flow', () => {
    it('should confirm a pending request: bed -> occupied, rental created (active), request -> approved', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app)
        .post('/api/requests')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ bed_id: bed._id.toString(), move_in_date: '2026-09-01', note: 'ASAP please' });
      expect(createRes.status).toBe(201);
      const requestId = createRes.body.data._id;

      const confirmRes = await request(app)
        .post(`/api/requests/${requestId}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.data.request.status).toBe(REQUEST_STATUS.APPROVED);
      expect(confirmRes.body.data.rental.status).toBe(RENTAL_STATUS.ACTIVE);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.OCCUPIED);

      const rentalCount = await Rental.countDocuments({ bed: bed._id });
      expect(rentalCount).toBe(1);
    });

    it('should reject confirming a request that is not pending', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      await request(app).post(`/api/requests/${requestId}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      const secondConfirm = await request(app).post(`/api/requests/${requestId}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      expect(secondConfirm.status).toBe(409);
    });

    it('should reject Owner B confirming Owner A\'s request (403)', async () => {
      const { ownerId: ownerAId } = await createOwner();
      const { token: ownerBToken } = await createOwner();
      const { bed } = await createBedFixture(ownerAId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      const res = await request(app).post(`/api/requests/${requestId}/confirm`).set('Authorization', `Bearer ${ownerBToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ========================================================================
  // Reject flow
  // ========================================================================
  describe('Reject Flow', () => {
    it('should reject a pending request with a structured reason: bed -> available, request -> rejected', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      const rejectRes = await request(app)
        .post(`/api/requests/${requestId}/reject`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: REQUEST_REJECTION_REASON.PRICE_DISAGREEMENT, note: 'Asked for a discount we cannot give' });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.data.status).toBe(REQUEST_STATUS.REJECTED);
      expect(rejectRes.body.data.rejection_reason).toBe(REQUEST_REJECTION_REASON.PRICE_DISAGREEMENT);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('should reject with 422 when the reason is missing or invalid', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      const res = await request(app)
        .post(`/api/requests/${requestId}/reject`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: 'not_a_real_reason' });

      expect(res.status).toBe(422);
    });

    it('should allow the bed to be requested again after rejection', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: student1Token } = await createStudent();
      const { token: student2Token } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${student1Token}`).send({ bed_id: bed._id.toString() });
      await request(app)
        .post(`/api/requests/${createRes.body.data._id}/reject`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: REQUEST_REJECTION_REASON.OTHER });

      const secondRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${student2Token}`).send({ bed_id: bed._id.toString() });
      expect(secondRes.status).toBe(201);
    });
  });

  // ========================================================================
  // request-expiry.job
  // ========================================================================
  describe('request-expiry.job — batch auto-expiry', () => {
    it('should expire a pending request past its expiry window, release the bed, and write a system audit entry', async () => {
      const { ownerId } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      // Force it into the past — normal creation sets expires_at 48h out.
      await RequestModel.findByIdAndUpdate(requestId, { expires_at: new Date(Date.now() - 1000) });

      const summary = await requestExpiryJob.runExpirySweep();
      expect(summary.totalExpired).toBe(1);

      const freshRequest = await RequestModel.findById(requestId);
      expect(freshRequest.status).toBe(REQUEST_STATUS.EXPIRED);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);

      const auditEntry = await Audit.findOne({ entity_type: 'Request', entity_id: requestId, action: 'request_expired' });
      expect(auditEntry).not.toBeNull();
      expect(auditEntry.actor).toBeNull();
    });

    it('should NOT touch a request that was already confirmed, even if its expires_at is in the past', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      await request(app).post(`/api/requests/${requestId}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      await RequestModel.findByIdAndUpdate(requestId, { expires_at: new Date(Date.now() - 1000) });

      await requestExpiryJob.runExpirySweep();

      const freshRequest = await RequestModel.findById(requestId);
      expect(freshRequest.status).toBe(REQUEST_STATUS.APPROVED); // untouched

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.OCCUPIED); // untouched
    });

    it('should process expirations in batches without loading the whole collection at once (CLAUDE.md Section 4.6)', async () => {
      const { ownerId } = await createOwner();
      const beds = [];
      for (let i = 0; i < 5; i += 1) {
        const { bed } = await createBedFixture(ownerId);
        beds.push(bed);
      }

      for (const bed of beds) {
        const { token } = await createStudent();
        const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${token}`).send({ bed_id: bed._id.toString() });
        await RequestModel.findByIdAndUpdate(createRes.body.data._id, { expires_at: new Date(Date.now() - 1000) });
      }

      const summary = await requestExpiryJob.runExpirySweep();
      expect(summary.totalExpired).toBe(5);

      const stillAvailable = await Bed.countDocuments({ _id: { $in: beds.map((b) => b._id) }, status: BED_STATUS.AVAILABLE });
      expect(stillAvailable).toBe(5);
    });
  });

  // ========================================================================
  // Rental move-out flow (vacating tracked on the rental, not the bed)
  // ========================================================================
  describe('Rental Move-Out Flow', () => {
    async function createActiveRental() {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const confirmRes = await request(app)
        .post(`/api/requests/${createRes.body.data._id}/confirm`)
        .set('Authorization', `Bearer ${ownerToken}`);

      return { ownerToken, bed, rentalId: confirmRes.body.data.rental._id };
    }

    it('should mark a rental as vacating WITHOUT changing the bed status (still occupied)', async () => {
      const { ownerToken, bed, rentalId } = await createActiveRental();

      const res = await request(app).post(`/api/rentals/${rentalId}/vacate`).set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(RENTAL_STATUS.VACATING);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.OCCUPIED); // deliberately unchanged
    });

    it('should finalize move-out: bed -> available, rental -> closed', async () => {
      const { ownerToken, bed, rentalId } = await createActiveRental();

      await request(app).post(`/api/rentals/${rentalId}/vacate`).set('Authorization', `Bearer ${ownerToken}`);
      const finalizeRes = await request(app).post(`/api/rentals/${rentalId}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);

      expect(finalizeRes.status).toBe(200);
      expect(finalizeRes.body.data.status).toBe(RENTAL_STATUS.CLOSED);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('should allow finalizing move-out directly from active, without going through vacating first', async () => {
      const { ownerToken, bed, rentalId } = await createActiveRental();

      const res = await request(app).post(`/api/rentals/${rentalId}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);

      const freshBed = await Bed.findById(bed._id);
      expect(freshBed.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('should reject marking an already-closed rental as vacating', async () => {
      const { ownerToken, rentalId } = await createActiveRental();

      await request(app).post(`/api/rentals/${rentalId}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);
      const res = await request(app).post(`/api/rentals/${rentalId}/vacate`).set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
    });

    it('should let the bed be requested again after move-out is finalized', async () => {
      const { ownerToken, bed, rentalId } = await createActiveRental();
      await request(app).post(`/api/rentals/${rentalId}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);

      const { token: newStudentToken } = await createStudent();
      const res = await request(app).post('/api/requests').set('Authorization', `Bearer ${newStudentToken}`).send({ bed_id: bed._id.toString() });

      expect(res.status).toBe(201);
    });
  });

  // ========================================================================
  // Owner-facing pending list with student summary (step 4)
  // ========================================================================
  describe('Owner-Facing Pending Requests List', () => {
    it('should return each pending request with its student profile/KYC summary attached', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { student, token: studentToken } = await createStudent();

      await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });

      const res = await request(app).get('/api/requests/pending').set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].student_summary.student.name).toBe(student.name);
      expect(res.body.data[0].student_summary.kyc_status).toBe('pending');
    });

    it('should only show a page bounded by pagination, even with many pending requests (no N+1 blow-up)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      for (let i = 0; i < 3; i += 1) {
        const { bed } = await createBedFixture(ownerId);
        const { token: studentToken } = await createStudent();
        await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      }

      const res = await request(app).get('/api/requests/pending').set('Authorization', `Bearer ${ownerToken}`).query({ page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(3);
    });
  });

  // ========================================================================
  // Owner-facing student full-profile view + explicit isolation test
  // (Phase 4 step 10 — required verbatim by the phase spec)
  // ========================================================================
  describe('Owner-Facing Student Full-Profile View (step 10)', () => {
    it('should allow an owner to view a student connected via a PENDING request', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { student, token: studentToken } = await createStudent();

      await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.student.name).toBe(student.name);
      expect(res.body.data.kyc_status).toBe('pending');
    });

    it('should allow an owner to view a student connected via an ACTIVE rental', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { student, token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
    });

    it('THE EXPLICIT ISOLATION TEST: Owner A must not be able to view KYC data for a student with no relationship to Owner A\'s buildings', async () => {
      const { ownerId: ownerAId } = await createOwner();
      const { token: ownerBToken } = await createOwner(); // unrelated owner
      const { bed } = await createBedFixture(ownerAId);
      const { student, token: studentToken } = await createStudent();

      // Student has a pending request with Owner A only.
      await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${ownerBToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject an owner viewing a student with zero requests/rentals anywhere', async () => {
      const { token: ownerToken } = await createOwner();
      const { student } = await createStudent(); // no request/rental at all

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject a rejected/expired-only relationship (no pending request, no active rental)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { student, token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      await request(app)
        .post(`/api/requests/${createRes.body.data._id}/reject`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: REQUEST_REJECTION_REASON.OTHER });

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(403);
    });
  });

  // ========================================================================
  // Phase 3 deletion-restriction retrofit (step 11)
  // ========================================================================
  describe('Deletion-Restriction Retrofit — rentals are now the authoritative signal', () => {
    it('should block deleting a bed with an active rental, with a rental-specific error message', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.message.toLowerCase()).toContain('rental');
    });

    it('should block deleting an apartment whose bed has an active rental', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { apartment, bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app).delete(`/api/apartments/${apartment._id}`).set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.message.toLowerCase()).toContain('rental');
    });

    it('should block deleting a building whose bed has an active rental', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { building, bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app).delete(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);
      expect(res.body.message.toLowerCase()).toContain('rental');
    });

    it('should still allow deleting a bed once its rental is closed (finalized move-out)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const confirmRes = await request(app).post(`/api/requests/${createRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      await request(app).post(`/api/rentals/${confirmRes.body.data.rental._id}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('should still block deleting a bed under maintenance with no rental (Phase 3\'s original status-based safety layer, still active)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId, { status: BED_STATUS.MAINTENANCE });

      const res = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(409);
      expect(res.body.message.toLowerCase()).not.toContain('rental'); // the OLD status-based message, not the new rental one
    });
  });

  // ========================================================================
  // Role guards
  // ========================================================================
  describe('Role Guards', () => {
    it('should reject an owner token creating a request (student only)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);

      const res = await request(app).post('/api/requests').set('Authorization', `Bearer ${ownerToken}`).send({ bed_id: bed._id.toString() });
      expect(res.status).toBe(403);
    });

    it('should reject a student token listing pending requests (owner only)', async () => {
      const { token: studentToken } = await createStudent();
      const res = await request(app).get('/api/requests/pending').set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
    });

    it('should reject a student token on rental routes (owner only)', async () => {
      const { token: studentToken } = await createStudent();
      const res = await request(app).get('/api/rentals').set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
    });

    it('should reject a student token viewing another student\'s full-profile (owner only)', async () => {
      const { student } = await createStudent();
      const { token: otherStudentToken } = await createStudent();

      const res = await request(app)
        .get(`/api/students/${student._id}/full-profile`)
        .set('Authorization', `Bearer ${otherStudentToken}`);

      expect(res.status).toBe(403); // requireRole(OWNER) rejects student role
    });

    it('should reject unauthenticated access to every new Phase 4 endpoint (401)', async () => {
      const createRes = await request(app).post('/api/requests').send({ bed_id: '000000000000000000000000' });
      const pendingRes = await request(app).get('/api/requests/pending');
      const myRes = await request(app).get('/api/requests/me');
      const rentalsRes = await request(app).get('/api/rentals');

      expect(createRes.status).toBe(401);
      expect(pendingRes.status).toBe(401);
      expect(myRes.status).toBe(401);
      expect(rentalsRes.status).toBe(401);
    });
  });
});
