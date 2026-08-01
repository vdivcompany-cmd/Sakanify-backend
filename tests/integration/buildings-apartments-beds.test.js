/**
 * buildings-apartments-beds.test.js
 *
 * Integration tests for Phase 3 (Buildings, Apartments, Beds, and the
 * real Audit module), covering:
 * - Building/Apartment/Bed CRUD, owner-scoped
 * - Ownership isolation (Owner A cannot read/write Owner B's hierarchy) —
 *   explicit negative tests per CLAUDE.md Section 6.3
 * - Hierarchy integrity: deletion blocked while children still exist
 *   (building->apartments, apartment->beds, bed status != available)
 * - Occupancy calculation
 * - Bed status changes writing to the real audit log via
 *   bed-history.service
 * - The Phase 2 KYC retrofit: verify/reject now also writes to the audit
 *   log
 * - Role-guard boundaries (student/owner/super-admin) on every route
 *   family, including the new audit endpoints
 *
 * Per CLAUDE.md Section 6 / project convention (Phase 1 lesson): every
 * test uses unique data (fresh owner/email per test via Date.now() +
 * Math.random(), matching students-kyc.test.js's uniquePhone() pattern).
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');
const User = require('../../src/modules/auth/auth.model');
const Building = require('../../src/modules/buildings/building.model');
const Apartment = require('../../src/modules/apartments/apartment.model');
const Bed = require('../../src/modules/beds/bed.model');
const Audit = require('../../src/modules/audit/audit.model');
const Kyc = require('../../src/modules/kyc/kyc.model');
const Student = require('../../src/modules/students/student.model');
const authService = require('../../src/modules/auth/auth.service');
const { ROLES, BED_STATUS } = require('../../src/config/constants.config');

let mongoServer;

async function createOwner() {
  const uniqueTag = `${Date.now()}-${Math.random()}`;
  const ownerId = `owner-${uniqueTag}`;
  const owner = await User.create({
    email: `owner-${uniqueTag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(owner._id.toString(), ROLES.OWNER, ownerId);
  return { owner, ownerId, token: accessToken };
}

async function createSuperAdmin() {
  const uniqueTag = `${Date.now()}-${Math.random()}`;
  const admin = await User.create({
    email: `admin-${uniqueTag}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(admin._id.toString(), ROLES.SUPER_ADMIN, null);
  return { admin, token: accessToken };
}

async function createStudentToken() {
  const uniqueTag = `${Date.now()}-${Math.random()}`;
  const student = await User.create({
    phone: `+2010${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
    role: ROLES.STUDENT,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(student._id.toString(), ROLES.STUDENT, null);
  return accessToken;
}

const VALID_BUILDING = {
  name: 'Al Salam Residence',
  area: 'Nasr City',
  address: { city: 'Cairo', street: 'Makram Ebeid', details: 'Building 12' },
};

async function createBuildingFor(token, overrides = {}) {
  const res = await request(app)
    .post('/api/buildings')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...VALID_BUILDING, ...overrides });
  return res.body.data;
}

async function createApartmentFor(token, buildingId, overrides = {}) {
  const res = await request(app)
    .post(`/api/buildings/${buildingId}/apartments`)
    .set('Authorization', `Bearer ${token}`)
    .send({ floor: 2, room_count: 3, ...overrides });
  return res.body.data;
}

async function createBedFor(token, apartmentId, overrides = {}) {
  const res = await request(app)
    .post(`/api/apartments/${apartmentId}/beds`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...overrides });
  return res.body.data;
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
  await Audit.deleteMany({});
  await Kyc.deleteMany({});
  await Student.deleteMany({});
});

describe('Buildings, Apartments, Beds & Audit — Integration Tests', () => {
  // ========== BUILDING CRUD ==========

  describe('Building CRUD', () => {
    it('should create a building for the authenticated owner', async () => {
      const { token, ownerId } = await createOwner();

      const res = await request(app)
        .post('/api/buildings')
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BUILDING);

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe(VALID_BUILDING.name);
      expect(res.body.data.owner_id).toBe(ownerId);
    });

    it('should reject building creation missing required fields', async () => {
      const { token } = await createOwner();

      const res = await request(app)
        .post('/api/buildings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Missing area and address' });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should list only the authenticated owner\'s buildings, paginated', async () => {
      const { token } = await createOwner();
      const { token: otherToken } = await createOwner();

      await createBuildingFor(token, { name: 'Building A' });
      await createBuildingFor(token, { name: 'Building B' });
      await createBuildingFor(otherToken, { name: 'Other Owner Building' });

      const res = await request(app).get('/api/buildings').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(2);
      expect(res.body.data.every((b) => b.name !== 'Other Owner Building')).toBe(true);
    });

    it('should retrieve a building with its nested apartments and beds', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      await createBedFor(token, apartment._id, { room_label: 'Room 1 - Bed A' });

      const res = await request(app).get(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.apartments.length).toBe(1);
      expect(res.body.data.apartments[0].beds.length).toBe(1);
      expect(res.body.data.apartments[0].beds[0].room_label).toBe('Room 1 - Bed A');
    });

    it('should update a building\'s own fields', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);

      const res = await request(app)
        .patch(`/api/buildings/${building._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Residence' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed Residence');
    });
  });

  // ========== OWNERSHIP ISOLATION (NEGATIVE TESTS) ==========

  describe('Ownership Isolation — Owner A cannot access Owner B\'s data', () => {
    it('should reject Owner B reading Owner A\'s building (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);

      const res = await request(app).get(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${ownerB}`);

      expect(res.status).toBe(403);
    });

    it('should reject Owner B updating Owner A\'s building (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);

      const res = await request(app)
        .patch(`/api/buildings/${building._id}`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ name: 'Hijacked Name' });

      expect(res.status).toBe(403);
    });

    it('should reject Owner B deleting Owner A\'s building (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);

      const res = await request(app).delete(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${ownerB}`);

      expect(res.status).toBe(403);
    });

    it('should reject Owner B creating an apartment under Owner A\'s building (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);

      const res = await request(app)
        .post(`/api/buildings/${building._id}/apartments`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ floor: 1, room_count: 2 });

      expect(res.status).toBe(403);
    });

    it('should reject Owner B reading/updating/deleting Owner A\'s apartment directly by id (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);
      const apartment = await createApartmentFor(ownerA, building._id);

      const getRes = await request(app).get(`/api/apartments/${apartment._id}`).set('Authorization', `Bearer ${ownerB}`);
      const patchRes = await request(app)
        .patch(`/api/apartments/${apartment._id}`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ floor: 5 });
      const deleteRes = await request(app).delete(`/api/apartments/${apartment._id}`).set('Authorization', `Bearer ${ownerB}`);

      expect(getRes.status).toBe(403);
      expect(patchRes.status).toBe(403);
      expect(deleteRes.status).toBe(403);
    });

    it('should reject Owner B reading/updating/deleting Owner A\'s bed directly by id (403)', async () => {
      const { token: ownerA } = await createOwner();
      const { token: ownerB } = await createOwner();
      const building = await createBuildingFor(ownerA);
      const apartment = await createApartmentFor(ownerA, building._id);
      const bed = await createBedFor(ownerA, apartment._id);

      const getRes = await request(app).get(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${ownerB}`);
      const patchRes = await request(app)
        .patch(`/api/beds/${bed._id}`)
        .set('Authorization', `Bearer ${ownerB}`)
        .send({ status: BED_STATUS.MAINTENANCE });
      const deleteRes = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${ownerB}`);

      expect(getRes.status).toBe(403);
      expect(patchRes.status).toBe(403);
      expect(deleteRes.status).toBe(403);
    });

    it('should confirm Owner A CAN access their own building (positive control for the isolation tests above)', async () => {
      const { token: ownerA } = await createOwner();
      const building = await createBuildingFor(ownerA);

      const res = await request(app).get(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${ownerA}`);

      expect(res.status).toBe(200);
    });
  });

  // ========== APARTMENT & BED CRUD ==========

  describe('Apartment & Bed CRUD', () => {
    it('should create an apartment under a building and list it paginated', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);

      await createApartmentFor(token, building._id, { floor: 1 });
      await createApartmentFor(token, building._id, { floor: 2 });

      const res = await request(app)
        .get(`/api/buildings/${building._id}/apartments`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(2);
    });

    it('should reject apartment creation with an invalid room_count', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);

      const res = await request(app)
        .post(`/api/buildings/${building._id}/apartments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ floor: 1, room_count: 0 });

      expect(res.status).toBe(422);
    });

    it('should create a bed under an apartment defaulting to "available" status', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);

      const bed = await createBedFor(token, apartment._id);

      expect(bed.status).toBe(BED_STATUS.AVAILABLE);
      expect(bed.apartment).toBe(apartment._id);
      expect(bed.building).toBe(building._id);
    });

    it('should list beds for an apartment, paginated', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      await createBedFor(token, apartment._id);
      await createBedFor(token, apartment._id);
      await createBedFor(token, apartment._id);

      const res = await request(app)
        .get(`/api/apartments/${apartment._id}/beds`)
        .set('Authorization', `Bearer ${token}`)
        .query({ page: 1, limit: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.meta.pages).toBe(2);
    });
  });

  // ========== HIERARCHY INTEGRITY (DELETE RESTRICTIONS) ==========

  describe('Hierarchy Integrity — deletion is blocked while children exist', () => {
    it('should block deleting a building that still has apartments', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      await createApartmentFor(token, building._id);

      const res = await request(app).delete(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('should allow deleting a building with no apartments', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);

      const res = await request(app).delete(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const stillExists = await Building.findById(building._id);
      expect(stillExists).toBeNull();
    });

    it('should block deleting an apartment that still has beds', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      await createBedFor(token, apartment._id);

      const res = await request(app).delete(`/api/apartments/${apartment._id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('should block deleting a bed that is not "available"', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      const bed = await createBedFor(token, apartment._id);

      await request(app)
        .patch(`/api/beds/${bed._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: BED_STATUS.OCCUPIED });

      const res = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
    });

    it('should allow deleting an available bed, then its now-empty apartment, then its now-empty building', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      const bed = await createBedFor(token, apartment._id);

      const bedDel = await request(app).delete(`/api/beds/${bed._id}`).set('Authorization', `Bearer ${token}`);
      expect(bedDel.status).toBe(200);

      const aptDel = await request(app).delete(`/api/apartments/${apartment._id}`).set('Authorization', `Bearer ${token}`);
      expect(aptDel.status).toBe(200);

      const bldDel = await request(app).delete(`/api/buildings/${building._id}`).set('Authorization', `Bearer ${token}`);
      expect(bldDel.status).toBe(200);
    });
  });

  // ========== OCCUPANCY CALCULATION ==========

  describe('Occupancy Calculation', () => {
    it('should compute correct occupancy counts across mixed bed statuses', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);

      const bed1 = await createBedFor(token, apartment._id);
      const bed2 = await createBedFor(token, apartment._id);
      const bed3 = await createBedFor(token, apartment._id);
      await createBedFor(token, apartment._id); // stays available

      await request(app).patch(`/api/beds/${bed1._id}`).set('Authorization', `Bearer ${token}`).send({ status: BED_STATUS.OCCUPIED });
      await request(app).patch(`/api/beds/${bed2._id}`).set('Authorization', `Bearer ${token}`).send({ status: BED_STATUS.OCCUPIED });
      await request(app).patch(`/api/beds/${bed3._id}`).set('Authorization', `Bearer ${token}`).send({ status: BED_STATUS.MAINTENANCE });

      const res = await request(app)
        .get(`/api/buildings/${building._id}/occupancy`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(4);
      expect(res.body.data.occupied).toBe(2);
      expect(res.body.data.maintenance).toBe(1);
      expect(res.body.data.available).toBe(1);
    });
  });

  // ========== BED STATUS CHANGES WRITE TO THE REAL AUDIT LOG ==========

  describe('Bed Status Changes -> Audit Log (bed-history.service)', () => {
    it('should write an audit entry when a bed\'s status changes, retrievable via the bed history endpoint', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      const bed = await createBedFor(token, apartment._id);

      await request(app)
        .patch(`/api/beds/${bed._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: BED_STATUS.OCCUPIED });

      const historyRes = await request(app).get(`/api/beds/${bed._id}/history`).set('Authorization', `Bearer ${token}`);

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.length).toBe(1);
      expect(historyRes.body.data[0].action).toBe('bed_status_change');
      expect(historyRes.body.data[0].before_state.status).toBe(BED_STATUS.AVAILABLE);
      expect(historyRes.body.data[0].after_state.status).toBe(BED_STATUS.OCCUPIED);

      const auditCount = await Audit.countDocuments({ entity_type: 'Bed', entity_id: bed._id });
      expect(auditCount).toBe(1);
    });

    it('should NOT write an audit entry when a bed update does not change status', async () => {
      const { token } = await createOwner();
      const building = await createBuildingFor(token);
      const apartment = await createApartmentFor(token, building._id);
      const bed = await createBedFor(token, apartment._id);

      await request(app)
        .patch(`/api/beds/${bed._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ room_label: 'Renamed room label' });

      const auditCount = await Audit.countDocuments({ entity_type: 'Bed', entity_id: bed._id });
      expect(auditCount).toBe(0);
    });
  });

  // ========== KYC RETROFIT: VERIFICATION STATUS CHANGES -> AUDIT LOG ==========

  describe('KYC Retrofit — verification status changes write to the real audit log', () => {
    async function createKycRecord() {
      const student = await Student.create({
        user: new mongoose.Types.ObjectId(),
        name: 'Audit Test Student',
        phone: `+2011${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`,
        college: 'Faculty of Science',
        academic_year: 1,
        smoking_preference: 'non_smoker',
      });
      const kyc = await Kyc.create({
        student: student._id,
        national_id_number: '29901011234599',
        national_id_photo: 'kyc/fake.png',
        student_photo: 'kyc/fake2.png',
      });
      return kyc;
    }

    it('should write a "kyc_status_change" audit entry when a super-admin verifies a KYC record', async () => {
      const kyc = await createKycRecord();
      const { token: adminToken, admin } = await createSuperAdmin();

      const res = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'verified' });

      expect(res.status).toBe(200);

      const entries = await Audit.find({ entity_type: 'Kyc', entity_id: kyc._id });
      expect(entries.length).toBe(1);
      expect(entries[0].action).toBe('kyc_status_change');
      expect(entries[0].before_state.verification_status).toBe('pending');
      expect(entries[0].after_state.verification_status).toBe('verified');
      expect(entries[0].actor.toString()).toBe(admin._id.toString());
    });

    it('should make the KYC audit entry retrievable via the super-admin audit query endpoint', async () => {
      const kyc = await createKycRecord();
      const { token: adminToken } = await createSuperAdmin();

      await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected' });

      const res = await request(app)
        .get('/api/audit')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ entity_type: 'Kyc', entity_id: kyc._id.toString() });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].after_state.verification_status).toBe('rejected');
    });
  });

  // ========== ROLE-GUARD BOUNDARIES ==========

  describe('Role Guards', () => {
    it('should reject a student token on the building creation endpoint (403)', async () => {
      const studentToken = await createStudentToken();

      const res = await request(app)
        .post('/api/buildings')
        .set('Authorization', `Bearer ${studentToken}`)
        .send(VALID_BUILDING);

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated access to buildings/apartments/beds/audit endpoints (401)', async () => {
      const buildingsRes = await request(app).get('/api/buildings');
      const apartmentsRes = await request(app).get('/api/apartments/000000000000000000000000');
      const bedsRes = await request(app).get('/api/beds/000000000000000000000000');
      const auditRes = await request(app).get('/api/audit');

      expect(buildingsRes.status).toBe(401);
      expect(apartmentsRes.status).toBe(401);
      expect(bedsRes.status).toBe(401);
      expect(auditRes.status).toBe(401);
    });

    it('should reject an owner token on the audit query endpoint (super-admin only)', async () => {
      const { token: ownerToken } = await createOwner();

      const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject a student token on the audit query endpoint (super-admin only)', async () => {
      const studentToken = await createStudentToken();

      const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(403);
    });

    it('should allow a super-admin to query the audit log', async () => {
      const { token: adminToken } = await createSuperAdmin();

      const res = await request(app).get('/api/audit').set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
