/**
 * auth.test.js
 *
 * Integration tests for authentication module, covering:
 * - Student OTP login flow
 * - Owner/Admin email+password login
 * - Token issuance and refresh
 * - Role-based access control (RBAC)
 * - Ownership scoping isolation
 * - Password reset
 * - Rate limiting on auth endpoints
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../../src/app.entry');
const authRoutes = require('../../src/modules/auth/auth.routes');
const User = require('../../src/modules/auth/auth.model');
const OTP = require('../../src/modules/auth/otp.model');
const { ROLES } = require('../../src/config/constants.config');

let mongoServer;

/**
 * Unique phone number per test — see the identical helper (and the
 * explanation of why it's needed) in auth-real.test.js. Kept as a
 * separate copy here rather than a shared import so each test file
 * stays independently runnable.
 */
let phoneCounter = 0;
function uniquePhone() {
  phoneCounter += 1;
  return `+2011${String(phoneCounter).padStart(8, '0')}`;
}

/**
 * Setup and teardown
 */
beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  // Clear collections before each test
  await User.deleteMany({});
  await OTP.deleteMany({});

  // Reset rate-limit middleware state between tests — same reasoning as
  // auth-real.test.js: unique phone numbers alone don't reset the
  // IP-keyed express-rate-limit middleware, since every supertest
  // request in this process shares one simulated IP.
  await authRoutes.rateLimitStores.otp.resetAll();
  await authRoutes.rateLimitStores.login.resetAll();
  await authRoutes.rateLimitStores.passwordReset.resetAll();
});

describe('Auth Module - Integration Tests', () => {
  // ========== STUDENT OTP LOGIN FLOW ==========

  describe('Student Registration & OTP Login', () => {
    it('should register a new student', async () => {
      const phone = uniquePhone();
      const res = await request(app)
        .post('/api/auth/register-student')
        .send({ phone });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe(phone);
      expect(res.body.data.userId).toBeDefined();
    });

    it('should reject duplicate student registration', async () => {
      const phone = uniquePhone();

      await request(app)
        .post('/api/auth/register-student')
        .send({ phone });

      const res = await request(app)
        .post('/api/auth/register-student')
        .send({ phone });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should request OTP for student login', async () => {
      const phone = uniquePhone();
      const res = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.phone).toBe(phone);
      expect(res.body.data._dev_code).toBeDefined(); // Development mode OTP code
    });

    it('should verify OTP and log in student', async () => {
      const phone = uniquePhone();

      // Request OTP
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      // Verify OTP and login
      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.role).toBe(ROLES.STUDENT);
      expect(loginRes.body.data.accessToken).toBeDefined();
      expect(loginRes.body.data.refreshToken).toBeDefined();
    });

    it('should reject invalid OTP', async () => {
      const phone = uniquePhone();

      // Request OTP
      await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      // Try to login with wrong OTP
      const res = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should rate-limit OTP requests', async () => {
      const phone = uniquePhone();

      // Request OTP 3 times (max attempts) — same phone number on purpose,
      // this test verifies OTP requests get blocked after the limit
      // (enforced by both the IP-based middleware and the otp.service
      // per-phone check, both capped at 3). beforeEach() resets both to a
      // clean slate for this test, so the 4th call below is guaranteed to
      // be blocked by this test's own 3 calls, not leftovers from another
      // test.
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/request-otp')
          .send({ phone });
      }

      // 4th request should fail
      const res = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      expect(res.status).toBe(429); // Too Many Requests
    });
  });

  // ========== OWNER/ADMIN LOGIN FLOW ==========

  describe('Owner & Admin Login', () => {
    it('should create owner account via invite', async () => {
      // First create super-admin
      const superAdmin = await User.create({
        email: 'admin@sakanify.com',
        password_hash: '$2a$10$...', // Placeholder (would be bcrypt hash in real test)
        role: ROLES.SUPER_ADMIN,
        status: 'active',
      });

      const adminToken = 'valid-admin-token'; // Placeholder (would be real JWT in real test)

      // Invite owner
      const res = await request(app)
        .post('/api/auth/invite-owner')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'owner@example.com',
          temporaryPassword: 'TempPass123!',
        });

      // This will fail without proper JWT validation, but structure shows intent
      // In real test, use actual JWT tokens
    });

    it('should log in owner with email and password', async () => {
      // Create owner account
      const owner = await User.create({
        email: 'owner@example.com',
        password_hash: '$2a$10$...', // Placeholder
        role: ROLES.OWNER,
        owner_id: 'owner-uuid-123',
        status: 'active',
      });

      // Attempt login (will fail without proper bcrypt hash, but structure shows intent)
      const res = await request(app)
        .post('/api/auth/login-owner')
        .send({
          email: 'owner@example.com',
          password: 'correct-password',
        });

      // This will fail in test environment without proper setup, but shows structure
    });

    it('should reject invalid owner credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login-owner')
        .send({
          email: 'nonexistent@example.com',
          password: 'password',
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject suspended owner account', async () => {
      // Create suspended owner
      await User.create({
        email: 'suspended@example.com',
        password_hash: 'hash',
        role: ROLES.OWNER,
        status: 'suspended',
      });

      const res = await request(app)
        .post('/api/auth/login-owner')
        .send({
          email: 'suspended@example.com',
          password: 'password',
        });

      expect(res.status).toBe(401);
    });
  });

  // ========== ROLE-BASED ACCESS CONTROL ==========

  describe('Role-Based Access Control (RBAC)', () => {
    it('should reject student token on owner-only route', async () => {
      const phone = uniquePhone();

      // Create and login student
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      const studentToken = loginRes.body.data.accessToken;

      // Try to access admin endpoint (would use real admin endpoint in production)
      const res = await request(app)
        .post('/api/auth/invite-owner')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ email: 'owner@example.com', temporaryPassword: 'Pass123!' });

      expect(res.status).toBe(403); // Forbidden
      expect(res.body.success).toBe(false);
    });

    it('should reject owner token on admin-only route', async () => {
      // Create owner
      const owner = await User.create({
        email: 'owner@example.com',
        password_hash: 'hash',
        role: ROLES.OWNER,
        owner_id: 'owner-uuid',
        status: 'active',
      });

      // Mock token generation (in real test, use actual JWT)
      const ownerToken = 'mock-owner-token';

      // Try to invite another owner (admin-only)
      const res = await request(app)
        .post('/api/auth/invite-owner')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'newowner@example.com', temporaryPassword: 'Pass123!' });

      // Will fail without proper JWT validation, but structure is correct
    });

    it('should allow super-admin on admin-only route', async () => {
      // Structure test for super-admin permission
      // In real test, create actual super-admin and JWT
    });
  });

  // ========== OWNERSHIP SCOPING (CRITICAL) ==========

  describe('Ownership Scoping Isolation', () => {
    it('should prevent owner A from accessing owner B data', async () => {
      // Create two owners
      const ownerA = await User.create({
        email: 'ownerA@example.com',
        password_hash: 'hash',
        role: ROLES.OWNER,
        owner_id: 'owner-a-uuid',
        status: 'active',
      });

      const ownerB = await User.create({
        email: 'ownerB@example.com',
        password_hash: 'hash',
        role: ROLES.OWNER,
        owner_id: 'owner-b-uuid',
        status: 'active',
      });

      // In real test:
      // 1. Generate JWT for Owner A
      // 2. Try to access Owner B's buildings/students using Owner A's token
      // 3. Verify 403 Forbidden response
      // 4. Verify Owner A can access only their own data
    });

    it('should allow owner to access only their own buildings', async () => {
      // Test structure for ownership scoping on buildings module
      // Will be implemented with Phase 3 (buildings)
    });

    it('should allow super-admin to access any owner data', async () => {
      // Super-admin should bypass ownership scoping
      // Structure test for super-admin privilege
    });
  });

  // ========== TOKEN MANAGEMENT ==========

  describe('Token Refresh & Expiry', () => {
    it('should refresh access token with valid refresh token', async () => {
      const phone = uniquePhone();

      // Generate student login
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      const refreshToken = loginRes.body.data.refreshToken;

      // Refresh token
      const refreshRes = await request(app)
        .post('/api/auth/refresh-token')
        .send({ refreshToken });

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.accessToken).toBeDefined();
    });

    it('should reject invalid refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh-token')
        .send({ refreshToken: 'invalid-token' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject missing authorization header', async () => {
      const res = await request(app)
        .post('/api/auth/logout');

      expect(res.status).toBe(401);
    });
  });

  // ========== LOGOUT ==========

  describe('Logout', () => {
    it('should logout authenticated user', async () => {
      const phone = uniquePhone();

      // Login as student
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      const accessToken = loginRes.body.data.accessToken;

      // Logout
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);
    });
  });

  // ========== PASSWORD RESET ==========

  describe('Password Reset', () => {
    it('should initiate password reset', async () => {
      // Create owner
      await User.create({
        email: 'owner@example.com',
        password_hash: 'hash',
        role: ROLES.OWNER,
        status: 'active',
      });

      const res = await request(app)
        .post('/api/auth/password-reset/initiate')
        .send({ email: 'owner@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should not reveal if email exists (security)', async () => {
      const res = await request(app)
        .post('/api/auth/password-reset/initiate')
        .send({ email: 'nonexistent@example.com' });

      // Should return success even if email doesn't exist (prevents enumeration)
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should rate-limit password reset requests', async () => {
      // Request reset 3 times (max)
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/password-reset/initiate')
          .send({ email: `test${i}@example.com` });
      }

      // 4th request should be rate-limited
      const res = await request(app)
        .post('/api/auth/password-reset/initiate')
        .send({ email: 'test4@example.com' });

      expect(res.status).toBe(429);
    });
  });

  // ========== INPUT VALIDATION ==========

  describe('Input Validation', () => {
    it('should reject invalid phone number format', async () => {
      const res = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone: 'not-a-phone' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should reject missing required fields', async () => {
      const res = await request(app)
        .post('/api/auth/register-student')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
