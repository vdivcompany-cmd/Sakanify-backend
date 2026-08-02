/**
 * students-kyc.test.js
 *
 * Integration tests for Phase 2 (Students & Simplified KYC), covering:
 * - Student registration (profile + initial KYC record together)
 * - Profile self-view and self-update
 * - KYC resubmission (rejected -> pending)
 * - Verification status updates (super-admin only)
 * - Role-guard boundaries (student/owner/super-admin)
 * - The scoping gap documented in the Phase 2 report: the owner-facing
 *   "view a student's KYC" endpoint is deliberately NOT built in this
 *   phase (Buildings/Rentals don't exist yet to scope it through), so the
 *   classic "Owner A cannot see Owner B's student" test can't be written
 *   as originally framed. See the last describe block below for the
 *   explicit, named test that documents and verifies this gap instead.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');
const authRoutes = require('../../src/modules/auth/auth.routes');
const User = require('../../src/modules/auth/auth.model');
const OTP = require('../../src/modules/auth/otp.model');
const Student = require('../../src/modules/students/student.model');
const Kyc = require('../../src/modules/kyc/kyc.model');
const authService = require('../../src/modules/auth/auth.service');
const otpService = require('../../src/modules/auth/otp.service');
const { ROLES } = require('../../src/config/constants.config');

let mongoServer;

// Unique phone number per test — same reasoning as auth.test.js /
// auth-real.test.js: the otp.service rate-limits per phone number, and
// several tests below register+login a fresh student.
let phoneCounter = 0;
function uniquePhone() {
  phoneCounter += 1;
  return `+2012${String(phoneCounter).padStart(8, '0')}`;
}

// Minimal valid 1x1 PNG (real magic bytes, so file-storage.adapter's
// content-sniffing accepts it) — used as the KYC photo fixture in every
// test that needs "a real image file".
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const NOT_AN_IMAGE_BUFFER = Buffer.from('this is definitely not an image file', 'utf8');

const VALID_PROFILE_FIELDS = {
  name: 'Ahmed Test',
  college: 'Faculty of Engineering',
  academic_year: '2',
  smoking_preference: 'non_smoker',
};

async function registerAndLoginStudent(phone) {
  await request(app).post('/api/auth/request-otp').send({ phone });
  // SEC-001 fix: the OTP code is no longer part of the response body —
  // read it back from the store via the test-only accessor instead.
  const otpCode = await otpService.__getLastOtpForPhone(phone);
  const loginRes = await request(app).post('/api/auth/verify-otp').send({ phone, code: otpCode });
  return loginRes.body.data.accessToken;
}

async function registerFullStudent(phone, nationalIdNumber) {
  // Student auth account must exist first (Phase 1 flow) so the
  // studentRoutes registration call can resolve req.user against a real
  // User document (student.service.registerStudent fetches phone from
  // the auth User record via authService.getUserById).
  await request(app).post('/api/auth/register-student').send({ phone });
  const token = await registerAndLoginStudent(phone);

  const res = await request(app)
    .post('/api/students/register')
    .set('Authorization', `Bearer ${token}`)
    .field('name', VALID_PROFILE_FIELDS.name)
    .field('college', VALID_PROFILE_FIELDS.college)
    .field('academic_year', VALID_PROFILE_FIELDS.academic_year)
    .field('smoking_preference', VALID_PROFILE_FIELDS.smoking_preference)
    .field('national_id_number', nationalIdNumber)
    .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png')
    .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

  return { res, token };
}

async function createSuperAdmin() {
  const admin = await User.create({
    email: `admin-${Date.now()}-${Math.random()}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.SUPER_ADMIN,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(admin._id.toString(), ROLES.SUPER_ADMIN, null);
  return { admin, token: accessToken };
}

async function createOwner() {
  const ownerId = `owner-${Date.now()}-${Math.random()}`;
  const owner = await User.create({
    email: `owner-${Date.now()}-${Math.random()}@sakanify.com`,
    password_hash: 'hash',
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });
  const { accessToken } = authService.issueTokens(owner._id.toString(), ROLES.OWNER, ownerId);
  return { owner, token: accessToken };
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
  await OTP.deleteMany({});
  await Student.deleteMany({});
  await Kyc.deleteMany({});

  await authRoutes.rateLimitStores.otp.resetAll();
  await authRoutes.rateLimitStores.login.resetAll();
  await authRoutes.rateLimitStores.passwordReset.resetAll();
});

describe('Students & KYC Module - Integration Tests', () => {
  // ========== REGISTRATION (PROFILE + INITIAL KYC TOGETHER) ==========

  describe('Student Registration', () => {
    it('should create the student profile and an initial "pending" KYC record together', async () => {
      const phone = uniquePhone();
      const { res } = await registerFullStudent(phone, '29901011234567');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.student.name).toBe(VALID_PROFILE_FIELDS.name);
      expect(res.body.data.student.phone).toBe(phone);
      expect(res.body.data.kyc_status).toBe('pending');

      // Confirm a real, separate KYC document was created (Implementation
      // Step 2: KYC as its own collection).
      const kycCount = await Kyc.countDocuments({});
      expect(kycCount).toBe(1);
    });

    it('should reject a second registration for the same auth account', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234501');

      const res = await request(app)
        .post('/api/students/register')
        .set('Authorization', `Bearer ${token}`)
        .field('name', VALID_PROFILE_FIELDS.name)
        .field('college', VALID_PROFILE_FIELDS.college)
        .field('academic_year', VALID_PROFILE_FIELDS.academic_year)
        .field('smoking_preference', VALID_PROFILE_FIELDS.smoking_preference)
        .field('national_id_number', '29901011234502')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png')
        .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should reject registration missing required profile fields', async () => {
      const phone = uniquePhone();
      await request(app).post('/api/auth/register-student').send({ phone });
      const token = await registerAndLoginStudent(phone);

      const res = await request(app)
        .post('/api/students/register')
        .set('Authorization', `Bearer ${token}`)
        .field('name', 'Only Name Provided')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png')
        .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should reject registration when national_id_number is not 14 digits', async () => {
      const phone = uniquePhone();
      await request(app).post('/api/auth/register-student').send({ phone });
      const token = await registerAndLoginStudent(phone);

      const res = await request(app)
        .post('/api/students/register')
        .set('Authorization', `Bearer ${token}`)
        .field('name', VALID_PROFILE_FIELDS.name)
        .field('college', VALID_PROFILE_FIELDS.college)
        .field('academic_year', VALID_PROFILE_FIELDS.academic_year)
        .field('smoking_preference', VALID_PROFILE_FIELDS.smoking_preference)
        .field('national_id_number', '123')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png')
        .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
    });

    it('should reject a file whose real content is not an image, even with an image field name', async () => {
      const phone = uniquePhone();
      await request(app).post('/api/auth/register-student').send({ phone });
      const token = await registerAndLoginStudent(phone);

      const res = await request(app)
        .post('/api/students/register')
        .set('Authorization', `Bearer ${token}`)
        .field('name', VALID_PROFILE_FIELDS.name)
        .field('college', VALID_PROFILE_FIELDS.college)
        .field('academic_year', VALID_PROFILE_FIELDS.academic_year)
        .field('smoking_preference', VALID_PROFILE_FIELDS.smoking_preference)
        .field('national_id_number', '29901011234599')
        .attach('national_id_photo', NOT_AN_IMAGE_BUFFER, { filename: 'id.jpg', contentType: 'image/jpeg' })
        .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ========== SELF PROFILE VIEW / UPDATE ==========

  describe('Student Self Profile', () => {
    it('should retrieve own profile with kyc_status, and never expose national_id fields', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234510');

      const res = await request(app).get('/api/students/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.student.name).toBe(VALID_PROFILE_FIELDS.name);
      expect(res.body.data.kyc_status).toBe('pending');
    });

    it('should update editable profile fields without touching KYC data', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234511');

      const res = await request(app)
        .patch('/api/students/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ college: 'Faculty of Medicine', academic_year: 4 });

      expect(res.status).toBe(200);
      expect(res.body.data.college).toBe('Faculty of Medicine');
      expect(res.body.data.academic_year).toBe(4);

      const kyc = await Kyc.findOne({}).select('+national_id_number');
      expect(kyc.national_id_number).toBe('29901011234511'); // untouched
    });

    it('should reject the KYC endpoint schema requirement that national_id_number never appears in a default query', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234512');

      const meRes = await request(app).get('/api/kyc/me').set('Authorization', `Bearer ${token}`);

      expect(meRes.status).toBe(200);
      expect(meRes.body.data.national_id_number).toBeUndefined();
      expect(meRes.body.data.national_id_photo).toBeUndefined();
      expect(meRes.body.data.verification_status).toBe('pending');
    });
  });

  // ========== KYC RESUBMISSION ==========

  describe('KYC Resubmission', () => {
    it('should reject resubmission while status is still "pending"', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234520');

      const res = await request(app)
        .post('/api/kyc/me/resubmit')
        .set('Authorization', `Bearer ${token}`)
        .field('national_id_number', '29901011234521')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png');

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('should allow resubmission after rejection and reset status to "pending"', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234530');
      const { token: adminToken } = await createSuperAdmin();

      const kyc = await Kyc.findOne({});
      const rejectRes = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected' });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.data.verification_status).toBe('rejected');

      const resubmitRes = await request(app)
        .post('/api/kyc/me/resubmit')
        .set('Authorization', `Bearer ${token}`)
        .field('national_id_number', '29901011234531')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id-v2.png');

      expect(resubmitRes.status).toBe(200);
      expect(resubmitRes.body.data.verification_status).toBe('pending');
    });
  });

  // ========== VERIFICATION STATUS UPDATES (SUPER-ADMIN ONLY) ==========

  describe('KYC Verification Status Updates', () => {
    it('should allow a super-admin to verify a KYC record', async () => {
      const phone = uniquePhone();
      await registerFullStudent(phone, '29901011234540');
      const { token: adminToken } = await createSuperAdmin();

      const kyc = await Kyc.findOne({});
      const res = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'verified' });

      expect(res.status).toBe(200);
      expect(res.body.data.verification_status).toBe('verified');
      expect(res.body.data.reviewed_by).toBeDefined();
      expect(res.body.data.reviewed_at).toBeDefined();
    });

    it('should reject an invalid status value', async () => {
      const phone = uniquePhone();
      await registerFullStudent(phone, '29901011234541');
      const { token: adminToken } = await createSuperAdmin();

      const kyc = await Kyc.findOne({});
      const res = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'approved-with-honors' });

      expect(res.status).toBe(400);
    });
  });

  // ========== ROLE-GUARD BOUNDARIES ==========

  describe('Role Guards', () => {
    it('should reject an owner token on the student registration endpoint', async () => {
      const { token: ownerToken } = await createOwner();

      const res = await request(app)
        .post('/api/students/register')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('name', VALID_PROFILE_FIELDS.name)
        .field('college', VALID_PROFILE_FIELDS.college)
        .field('academic_year', VALID_PROFILE_FIELDS.academic_year)
        .field('smoking_preference', VALID_PROFILE_FIELDS.smoking_preference)
        .field('national_id_number', '29901011234550')
        .attach('national_id_photo', VALID_PNG_BUFFER, 'id.png')
        .attach('student_photo', VALID_PNG_BUFFER, 'photo.png');

      expect(res.status).toBe(403);
    });

    it('should reject a student token on the KYC verification-status endpoint (super-admin only)', async () => {
      const phone = uniquePhone();
      const { token } = await registerFullStudent(phone, '29901011234560');
      const kyc = await Kyc.findOne({});

      const res = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'verified' });

      expect(res.status).toBe(403);
    });

    it('should reject an owner token on the KYC verification-status endpoint (super-admin only)', async () => {
      const phone = uniquePhone();
      await registerFullStudent(phone, '29901011234561');
      const kyc = await Kyc.findOne({});
      const { token: ownerToken } = await createOwner();

      const res = await request(app)
        .patch(`/api/kyc/${kyc._id}/status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'verified' });

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated access to every student/KYC endpoint', async () => {
      const meRes = await request(app).get('/api/students/me');
      const kycRes = await request(app).get('/api/kyc/me');

      expect(meRes.status).toBe(401);
      expect(kycRes.status).toBe(401);
    });
  });

  // ========== OWNER-FACING SCOPE ==========
  //
  // Deferred out of this phase (Phase 2) in the original implementation —
  // Buildings/Rentals, which the relationship would be scoped through,
  // didn't exist yet. Now built in Phase 4
  // (Docs/phase-4-booking-engine.md step 10) as
  // GET /api/students/:studentId/full-profile, relationship-scoped via
  // request/rental data instead of a simple owner_id match. The real
  // coverage (including the Owner-A-cannot-see-Owner-B's-student
  // isolation test) now lives in
  // tests/integration/booking-engine.test.js. This block just confirms
  // the bare, un-suffixed path was never a route, before or after Phase 4.

  describe('Owner-Facing KYC View — path shape sanity check', () => {
    it('should return 404 for the bare /api/students/:id path (the real endpoint is /:studentId/full-profile, added in Phase 4)', async () => {
      const phone = uniquePhone();
      await registerFullStudent(phone, '29901011234570');
      const student = await Student.findOne({});
      const { token: ownerToken } = await createOwner();

      const res = await request(app)
        .get(`/api/students/${student._id}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(404);
    });
  });
});
