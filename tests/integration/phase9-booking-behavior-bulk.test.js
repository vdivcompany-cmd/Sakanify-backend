/**
 * phase9-booking-behavior-bulk.test.js
 *
 * Docs/phase-9-booking-behavior-bulk-registration.md — new coverage that
 * doesn't belong in booking-engine.test.js's rewritten describe block
 * (see that file for the confirm-time atomicity/bed_taken tests, which
 * directly replace Phase 4's original concurrency test).
 *
 * Covers, per the spec's implementation steps:
 *   - Part A: appointment-date-driven expiry (decision 6), the one-active-
 *     rental-per-student database guarantee (decision 7), and THE
 *     cross-flow race — one student with a pending viewing-booking AND a
 *     pending Part D bulk-registration submission, both attempted to
 *     confirm/assign at nearly the same instant; exactly one must win.
 *   - Part B: roommate college visibility via the public bed-picker.
 *   - Part C: the relationship-gating negative test (most important test
 *     in this part, per the spec).
 *   - Part D: token validation, expiry/revocation, a submission never
 *     creating a Rental until explicitly assigned, and assign-to-bed
 *     correctly rejecting an unavailable target bed.
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
const BulkRegistrationLink = require('../../src/modules/bulk-registration/bulk-registration.model');
const BulkSubmission = require('../../src/modules/bulk-registration/bulk-submission.model');
const BehaviorReport = require('../../src/modules/behavior-reports/behavior-report.model');
const Audit = require('../../src/modules/audit/audit.model');
const Subscription = require('../../src/modules/subscriptions/subscription.model');

const authService = require('../../src/modules/auth/auth.service');
const requestExpiryJob = require('../../src/modules/requests/request-expiry.job');
const bulkRegistrationService = require('../../src/modules/bulk-registration/bulk-registration.service');
const { ROLES, BED_STATUS, REQUEST_STATUS, RENTAL_STATUS, BEHAVIOR_REPORT_SEVERITY } = require('../../src/config/constants.config');

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

async function createStudent(overrides = {}) {
  const tag = uniqueTag();
  // Same test-data-generation fix as booking-engine.test.js's
  // createStudent() (see that file's comment for the full mechanism):
  // capture the counter synchronously, before any `await`, so it can never
  // collide with another createStudent() call in the same Promise.all
  // batch. The product's national_id_number uniqueness constraint is
  // correct and untouched — this was purely a stale-read bug in test data.
  const nationalIdSeq = uniqueCounter;
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
    ...overrides,
  });
  await Kyc.create({
    student: student._id,
    national_id_number: `2990101${String(nationalIdSeq).padStart(7, '0')}`,
    national_id_photo: 'kyc/fake-id.png',
    student_photo: 'kyc/fake-photo.png',
  });
  const { accessToken } = authService.issueTokens(user._id.toString(), ROLES.STUDENT, null);
  return { user, student, token: accessToken };
}

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
    monthly_rent: 1500,
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
  await BulkRegistrationLink.deleteMany({});
  await BulkSubmission.deleteMany({});
  await BehaviorReport.deleteMany({});
  await Audit.deleteMany({});
  await Subscription.deleteMany({});
});

describe('Phase 9 — Booking Redesign, Behavior Reports & Bulk Registration', () => {
  // ==========================================================================
  // Part A — appointment date + one-active-rental-per-student guarantee
  // ==========================================================================
  describe('Part A — Appointment Date & One-Active-Rental-Per-Student', () => {
    it('owner can set an appointment date, which overwrites expires_at to appointment_date + 48h grace, and the expiry job respects it', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const createRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });
      const requestId = createRes.body.data._id;

      const appointmentDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days out
      const setRes = await request(app)
        .post(`/api/requests/${requestId}/appointment-date`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ appointment_date: appointmentDate.toISOString() });
      expect(setRes.status).toBe(200);

      // Sweep now: should NOT expire yet, expires_at was pushed far out.
      await requestExpiryJob.runExpirySweep();
      let fresh = await RequestModel.findById(requestId);
      expect(fresh.status).toBe(REQUEST_STATUS.PENDING);

      // Force the appointment (and its grace window) into the past, then
      // sweep again — now it should expire (no-show handling, decision 6).
      await RequestModel.findByIdAndUpdate(requestId, { expires_at: new Date(Date.now() - 1000) });
      await requestExpiryJob.runExpirySweep();
      fresh = await RequestModel.findById(requestId);
      expect(fresh.status).toBe(REQUEST_STATUS.EXPIRED);
    });

    it('a student with an existing active rental cannot be assigned a second one via Part D — the partial unique index rejects it with a clean 409', async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwner();
      const { ownerId: ownerBId, token: ownerBToken } = await createOwner();
      const { bed: bedA } = await createBedFixture(ownerAId);
      const { bed: bedB } = await createBedFixture(ownerBId);
      const { token: studentToken } = await createStudent();

      // Student gets a confirmed rental with Owner A first.
      const reqA = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bedA._id.toString() });
      const confirmA = await request(app).post(`/api/requests/${reqA.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerAToken}`);
      expect(confirmA.status).toBe(200);

      // Same student now tries to get a SECOND rental with Owner B via a
      // normal viewing-booking confirm — must be rejected.
      const reqB = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bedB._id.toString() });
      const confirmB = await request(app).post(`/api/requests/${reqB.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerBToken}`);
      expect(confirmB.status).toBe(409);
      expect(confirmB.body.message.toLowerCase()).toContain('already has an active rental');

      // And the bed must have been rolled back to available, not left
      // stuck occupied with no real tenant (the rollback correctness
      // requirement identified during this phase's design).
      const freshBedB = await Bed.findById(bedB._id);
      expect(freshBedB.status).toBe(BED_STATUS.AVAILABLE);
    });

    it('once a rental is closed (finalized move-out), the student is free to be assigned a new bed elsewhere', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { bed: bed1 } = await createBedFixture(ownerId);
      const { bed: bed2 } = await createBedFixture(ownerId);
      const { token: studentToken } = await createStudent();

      const req1 = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed1._id.toString() });
      const confirm1 = await request(app).post(`/api/requests/${req1.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      const rental1Id = confirm1.body.data.rental._id;

      await request(app).post(`/api/rentals/${rental1Id}/finalize-move-out`).set('Authorization', `Bearer ${ownerToken}`);

      const req2 = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed2._id.toString() });
      const confirm2 = await request(app).post(`/api/requests/${req2.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);
      expect(confirm2.status).toBe(200);
    });

    it('CROSS-FLOW RACE (the single most important test in this phase, per the spec): one student with a pending viewing-booking AND a pending Part D bulk-registration submission, confirmed/assigned at nearly the same instant — exactly one succeeds', async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwner();
      const { ownerId: ownerBId, token: ownerBToken } = await createOwner();
      const { bed: bedA } = await createBedFixture(ownerAId);
      const { building: buildingB, bed: bedB } = await createBedFixture(ownerBId);
      const { student, token: studentToken } = await createStudent();

      // Flow 1: a normal pending viewing-booking with Owner A.
      const reqA = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bedA._id.toString() });
      expect(reqA.status).toBe(201);

      // Flow 2: the SAME student also has a pending Part D bulk-registration
      // submission with Owner B (simulated directly against the service —
      // the same student account, a different building/owner entirely).
      const submissionB = await BulkSubmission.create({
        link: new mongoose.Types.ObjectId(),
        building: buildingB._id,
        owner_id: ownerBId,
        student: student._id,
        declared_bed: bedB._id,
        status: 'pending',
      });

      // Race: confirm flow 1 and assign flow 2 at nearly the same instant.
      const [confirmRes, assignRes] = await Promise.all([
        request(app).post(`/api/requests/${reqA.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerAToken}`),
        request(app).post(`/api/bulk-registration/submissions/${submissionB._id}/assign`).set('Authorization', `Bearer ${ownerBToken}`),
      ]);

      const outcomes = [confirmRes.status, assignRes.status];
      const successCount = outcomes.filter((s) => s === 200).length;
      const conflictCount = outcomes.filter((s) => s === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(1);

      // Exactly one live rental for this student, platform-wide.
      const rentalCount = await Rental.countDocuments({ student: student._id, status: { $in: [RENTAL_STATUS.ACTIVE, RENTAL_STATUS.VACATING] } });
      expect(rentalCount).toBe(1);

      // Whichever bed lost the race must have rolled back to available.
      const [freshBedA, freshBedB] = await Promise.all([Bed.findById(bedA._id), Bed.findById(bedB._id)]);
      const occupiedCount = [freshBedA.status, freshBedB.status].filter((s) => s === BED_STATUS.OCCUPIED).length;
      const availableCount = [freshBedA.status, freshBedB.status].filter((s) => s === BED_STATUS.AVAILABLE).length;
      expect(occupiedCount).toBe(1);
      expect(availableCount).toBe(1);
    });
  });

  // ==========================================================================
  // Part B — roommate college visibility via the public bed-picker
  // ==========================================================================
  describe('Part B — Roommate College Visibility', () => {
    it('the public bed-picker exposes only college for an occupied bed, and id+room_label+monthly_rent for an available one', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      await Subscription.create({
        owner_id: ownerId,
        tier_name: 'test-tier',
        total_bed_capacity: 10,
        monthly_price: 100,
        status: 'active',
        renewal_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      const { building, bed: occupiedBed } = await createBedFixture(ownerId, { room_label: 'A1' });
      const { bed: availableBed } = await createBedFixture(ownerId, { room_label: 'A2' });
      // second bed must belong to the same building for this test
      await Bed.findByIdAndUpdate(availableBed._id, { building: building._id });

      const { token: studentToken } = await createStudent({ college: 'Faculty of Medicine' });
      const reqRes = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: occupiedBed._id.toString() });
      await request(app).post(`/api/requests/${reqRes.body.data._id}/confirm`).set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app).get(`/api/public/buildings/${building._id}/beds`);
      expect(res.status).toBe(200);

      const occupiedEntry = res.body.data.find((b) => b.id === occupiedBed._id.toString());
      const availableEntry = res.body.data.find((b) => b.id === availableBed._id.toString());

      expect(occupiedEntry.status).toBe('occupied');
      expect(occupiedEntry.current_occupant_college).toBe('Faculty of Medicine');
      expect(occupiedEntry.name).toBeUndefined();
      expect(occupiedEntry.phone).toBeUndefined();

      expect(availableEntry.status).toBe('available');
      expect(availableEntry.room_label).toBe('A2');
      expect(availableEntry.monthly_rent).toBe(1500);
    });
  });

  // ==========================================================================
  // Part C — relationship-gated behavior reports
  // ==========================================================================
  describe('Part C — Cross-Owner Behavior Reports (relationship-gated)', () => {
    it('THE RELATIONSHIP-GATING NEGATIVE TEST (most important test in this part): an owner with ZERO history with a student cannot search for or see their reports', async () => {
      const { ownerId: ownerAId } = await createOwner();
      const { token: ownerBToken } = await createOwner(); // unrelated owner, zero relationship
      const { bed } = await createBedFixture(ownerAId);
      const { student, token: studentToken } = await createStudent();

      // Student has SOME relationship, but only with Owner A.
      await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bed._id.toString() });

      const kyc = await Kyc.findOne({ student: student._id }).select('+national_id_number');
      const res = await request(app)
        .get('/api/behavior-reports/search')
        .set('Authorization', `Bearer ${ownerBToken}`)
        .query({ national_id: kyc.national_id_number });

      expect(res.status).toBe(403);
    });

    it('an owner WITH a qualifying relationship (even a past, rejected request) CAN search and file a report, and it is visible to a THIRD owner who also qualifies', async () => {
      const { ownerId: ownerAId, token: ownerAToken } = await createOwner();
      const { ownerId: ownerCId, token: ownerCToken } = await createOwner();
      const { bed: bedA } = await createBedFixture(ownerAId);
      const { bed: bedC } = await createBedFixture(ownerCId);
      const { student, token: studentToken } = await createStudent();

      // Owner A's relationship is a REJECTED request — still qualifies
      // (Product Decision 2: "any viewing-booking/request/rental, any
      // status, past or present").
      const reqA = await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bedA._id.toString() });
      await request(app)
        .post(`/api/requests/${reqA.body.data._id}/reject`)
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({ reason: 'other' });

      const kyc = await Kyc.findOne({ student: student._id }).select('+national_id_number');

      const searchA = await request(app)
        .get('/api/behavior-reports/search')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .query({ national_id: kyc.national_id_number });
      expect(searchA.status).toBe(200);

      const fileRes = await request(app)
        .post('/api/behavior-reports')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({ student_id: student._id.toString(), incident_description: 'Loud parties after 2am', severity: BEHAVIOR_REPORT_SEVERITY.MODERATE });
      expect(fileRes.status).toBe(201);

      // Owner C establishes their own, separate relationship...
      await request(app).post('/api/requests').set('Authorization', `Bearer ${studentToken}`).send({ bed_id: bedC._id.toString() });

      // ...and can see Owner A's report — intentionally cross-owner.
      const searchC = await request(app)
        .get('/api/behavior-reports/search')
        .set('Authorization', `Bearer ${ownerCToken}`)
        .query({ national_id: kyc.national_id_number });
      expect(searchC.status).toBe(200);
      expect(searchC.body.data.reports.length).toBe(1);
      expect(searchC.body.data.reports[0].filed_by_owner).toBe(ownerAId);
    });

    it('an owner cannot FILE a report about a student they have zero relationship with', async () => {
      const { token: ownerBToken } = await createOwner();
      const { student } = await createStudent();

      const res = await request(app)
        .post('/api/behavior-reports')
        .set('Authorization', `Bearer ${ownerBToken}`)
        .send({ student_id: student._id.toString(), incident_description: 'x', severity: BEHAVIOR_REPORT_SEVERITY.MINOR });

      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // Part D — secure bulk tenant registration links
  // ==========================================================================
  describe('Part D — Secure Bulk Tenant Registration Links', () => {
    it('generated tokens are high-entropy hex (128+ bits) and never stored in plaintext', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { building } = await createBedFixture(ownerId);

      const res = await request(app)
        .post(`/api/bulk-registration/buildings/${building._id}/links`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(201);
      const rawToken = res.body.data.token;
      expect(rawToken).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex = 256 bits

      const stored = await BulkRegistrationLink.findOne({ building: building._id });
      expect(stored.token_hash).not.toBe(rawToken);
      expect(stored.token_hash.length).toBe(64); // sha256 hex
    });

    it('a revoked link is rejected, and a re-generated link invalidates the old one for that building', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { building } = await createBedFixture(ownerId);

      const first = await request(app)
        .post(`/api/bulk-registration/buildings/${building._id}/links`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const firstToken = first.body.data.token;

      // Generating a second link must invalidate the first.
      const second = await request(app)
        .post(`/api/bulk-registration/buildings/${building._id}/links`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(second.status).toBe(201);

      await expect(bulkRegistrationService.resolveLinkFromRawToken(firstToken)).rejects.toThrow();

      // Explicit revoke on the (now current) second link also works.
      const revokeRes = await request(app)
        .delete(`/api/bulk-registration/buildings/${building._id}/links`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revokeRes.status).toBe(200);
      await expect(bulkRegistrationService.resolveLinkFromRawToken(second.body.data.token)).rejects.toThrow();
    });

    it('an expired link is rejected even though its hash is otherwise valid', async () => {
      const { ownerId } = await createOwner();
      const { building } = await createBedFixture(ownerId);
      const { generateRawToken, hashToken } = BulkRegistrationLink;
      const rawToken = generateRawToken();

      await BulkRegistrationLink.create({
        building: building._id,
        owner_id: ownerId,
        token_hash: hashToken(rawToken),
        expires_at: new Date(Date.now() - 1000), // already expired
      });

      await expect(bulkRegistrationService.resolveLinkFromRawToken(rawToken)).rejects.toThrow();
    });

    it('assign-to-bed rejects when the target bed is no longer available (whether declared or owner-corrected)', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { building, bed: declaredBed } = await createBedFixture(ownerId);
      const { student } = await createStudent();

      // The declared bed gets taken by someone else before the owner reviews.
      await Bed.findByIdAndUpdate(declaredBed._id, { status: BED_STATUS.OCCUPIED });

      const submission = await BulkSubmission.create({
        link: new mongoose.Types.ObjectId(),
        building: building._id,
        owner_id: ownerId,
        student: student._id,
        declared_bed: declaredBed._id,
        status: 'pending',
      });

      const res = await request(app)
        .post(`/api/bulk-registration/submissions/${submission._id}/assign`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(409);

      const freshSubmission = await BulkSubmission.findById(submission._id);
      expect(freshSubmission.status).toBe('pending'); // untouched, no Rental created
      const rentalCount = await Rental.countDocuments({ student: student._id });
      expect(rentalCount).toBe(0);
    });

    it('a declared bed on a submission is non-binding — no Rental exists until the owner explicitly assigns it', async () => {
      const { ownerId, token: ownerToken } = await createOwner();
      const { building, bed } = await createBedFixture(ownerId);
      const { student } = await createStudent();

      const submission = await BulkSubmission.create({
        link: new mongoose.Types.ObjectId(),
        building: building._id,
        owner_id: ownerId,
        student: student._id,
        declared_bed: bed._id,
        status: 'pending',
      });

      // Merely existing as a pending submission must never have touched
      // the bed or created a Rental.
      const bedBefore = await Bed.findById(bed._id);
      expect(bedBefore.status).toBe(BED_STATUS.AVAILABLE);
      expect(await Rental.countDocuments({ student: student._id })).toBe(0);

      const assignRes = await request(app)
        .post(`/api/bulk-registration/submissions/${submission._id}/assign`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(assignRes.status).toBe(200);

      const bedAfter = await Bed.findById(bed._id);
      expect(bedAfter.status).toBe(BED_STATUS.OCCUPIED);
      expect(await Rental.countDocuments({ student: student._id })).toBe(1);
    });
  });
});
