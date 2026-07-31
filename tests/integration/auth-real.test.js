/**
 * auth-real.test.js
 *
 * اختبارات تكامل حقيقية للمصادقة:
 * - تشغيل فعلي ضد MongoDB
 * - اختبار عزل الملكية (الحرج جداً)
 * - اختبار OTP والتحديد
 * - اختبار تسجيل الدخول
 */

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../src/app.entry');
const authRoutes = require('../../src/modules/auth/auth.routes');
const User = require('../../src/modules/auth/auth.model');
const OTP = require('../../src/modules/auth/otp.model');
const authService = require('../../src/modules/auth/auth.service');
const { ROLES } = require('../../src/config/constants.config');

const env = require('../../src/config/env.config');

/**
 * Unique phone number generator for tests.
 *
 * Root cause of the CI failures this fixes: many tests in this file used
 * the SAME hardcoded phone number (e.g. +201234567890). The otp.service
 * layer counts recent OTP requests PER PHONE NUMBER and rejects the 4th
 * one within the window (by design — that's the anti-spam control working
 * correctly, see otp.service.js). Reusing one phone across many tests
 * tripped that check well before any individual test's own logic did.
 *
 * Giving every test its own phone number removes that cross-test
 * interference without changing the OTP service's real rate-limiting
 * logic at all.
 */
let phoneCounter = 0;
function uniquePhone() {
  phoneCounter += 1;
  // +20 1 XX XXXXXXX shaped, padded so it stays a plausible Egyptian number
  return `+2010${String(phoneCounter).padStart(8, '0')}`;
}

describe('🔐 Auth Integration Tests — Real Database', () => {
  beforeAll(async () => {
    // Connect to real MongoDB
    if (!mongoose.connection.readyState) {
      await mongoose.connect(env.mongodbUri, {
        serverSelectionTimeoutMS: 5000,
      });
    }
  });

  afterAll(async () => {
    // Clean up and disconnect
    await User.deleteMany({});
    await OTP.deleteMany({});
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    // Clear collections before each test
    await User.deleteMany({});
    await OTP.deleteMany({});

    // Reset the IP-based rate-limit middleware between tests too.
    //
    // Unique phone numbers (above) fix the otp.service's per-phone check,
    // but express-rate-limit's OTP/login/password-reset middleware keys
    // its counters by client IP by default — and every supertest request
    // in this process shares the same simulated IP. Without this reset,
    // the middleware layer would still exhaust itself after the first
    // few tests regardless of phone number uniqueness.
    //
    // This calls the store's official resetAll() API (see auth.routes.js)
    // — it does not touch the actual max/windowMs security configuration.
    await authRoutes.rateLimitStores.otp.resetAll();
    await authRoutes.rateLimitStores.login.resetAll();
    await authRoutes.rateLimitStores.passwordReset.resetAll();
  });

  // ========== اختبار 1: تدفق OTP للطالب ==========
  describe('✅ Student OTP Login Flow', () => {
    test('should register and login student with OTP', async () => {
      const phone = uniquePhone();

      // Step 1: Request OTP
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      expect(otpRes.status).toBe(200);
      expect(otpRes.body.success).toBe(true);
      const otpCode = otpRes.body.data._dev_code; // Development mode code
      expect(otpCode).toBeDefined();
      console.log(`  📱 OTP generated for ${phone}: ${otpCode}`);

      // Step 2: Verify OTP and login
      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.success).toBe(true);
      expect(loginRes.body.data.role).toBe(ROLES.STUDENT);
      expect(loginRes.body.data.accessToken).toBeDefined();
      expect(loginRes.body.data.refreshToken).toBeDefined();

      console.log(`  ✓ Student logged in successfully`);
      console.log(`    - Role: ${loginRes.body.data.role}`);
      console.log(`    - Token expires in: ${env.jwt.accessExpiry}`);
    });

    test('should reject invalid OTP code', async () => {
      const phone = uniquePhone();

      // Request OTP
      await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      // Try with wrong code
      const res = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: '000000' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      console.log(`  ✓ Invalid OTP correctly rejected`);
    });
  });

  // ========== اختبار 2: عزل الملكية (الحرج جداً) ==========
  describe('🔒 CRITICAL: Ownership Scoping Isolation', () => {
    test('Owner A cannot access Owner B data', async () => {
      // Create two owners manually
      const ownerA = await User.create({
        email: 'ownerA@test.com',
        password_hash: await authService.hashPassword('Password123!'),
        role: ROLES.OWNER,
        owner_id: 'owner-a-uuid-12345',
        status: 'active',
      });

      const ownerB = await User.create({
        email: 'ownerB@test.com',
        password_hash: await authService.hashPassword('Password456!'),
        role: ROLES.OWNER,
        owner_id: 'owner-b-uuid-67890',
        status: 'active',
      });

      console.log(`  👤 Created Owner A: ${ownerA.email} (ID: ${ownerA.owner_id})`);
      console.log(`  👤 Created Owner B: ${ownerB.email} (ID: ${ownerB.owner_id})`);

      // Login Owner A
      const loginA = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'ownerA@test.com', password: 'Password123!' });

      expect(loginA.status).toBe(200);
      const tokenA = loginA.body.data.accessToken;
      const ownerIdA = loginA.body.data.ownerId;

      console.log(`  🔑 Owner A logged in with token: ${tokenA.substring(0, 20)}...`);
      console.log(`  🆔 Owner A's owner_id: ${ownerIdA}`);

      // Verify the token contains correct ownership info
      const decodedA = authService.verifyToken(tokenA);
      expect(decodedA.ownerId).toBe('owner-a-uuid-12345');
      console.log(`  ✓ Token correctly contains Owner A's owner_id`);

      // Login Owner B
      const loginB = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'ownerB@test.com', password: 'Password456!' });

      expect(loginB.status).toBe(200);
      const tokenB = loginB.body.data.accessToken;
      const ownerIdB = loginB.body.data.ownerId;

      console.log(`  🔑 Owner B logged in with token: ${tokenB.substring(0, 20)}...`);
      console.log(`  🆔 Owner B's owner_id: ${ownerIdB}`);

      // Verify different ownership
      expect(ownerIdA).not.toBe(ownerIdB);
      console.log(`  ✓ Owner A and Owner B have different owner_ids`);

      // Test the ownershipScoping function directly
      const { ownershipScoping } = require('../../src/middleware/auth.middleware');

      // Owner A trying to access Owner B's data should fail
      try {
        ownershipScoping(ownerIdA, ownerIdB);
        throw new Error('Should have thrown error');
      } catch (err) {
        expect(err.message).toContain('do not have permission');
        console.log(`  ✓ CRITICAL: ownershipScoping correctly blocked Owner A from accessing Owner B data`);
        console.log(`    Error message: "${err.message}"`);
      }

      // Owner A accessing own data should succeed
      try {
        ownershipScoping(ownerIdA, ownerIdA);
        console.log(`  ✓ CRITICAL: ownershipScoping correctly allowed Owner A to access own data`);
      } catch (err) {
        throw new Error('Should not have thrown error for same owner');
      }

      // Owner B trying to access Owner A's data should fail
      try {
        ownershipScoping(ownerIdB, ownerIdA);
        throw new Error('Should have thrown error');
      } catch (err) {
        expect(err.message).toContain('do not have permission');
        console.log(`  ✓ CRITICAL: ownershipScoping correctly blocked Owner B from accessing Owner A data`);
      }
    });
  });

  // ========== اختبار 3: تسجيل دخول صاحب المبنى ==========
  describe('👤 Owner Login', () => {
    test('should login owner with email and password', async () => {
      // Create owner
      const passwordHash = await authService.hashPassword('MyPassword123!');
      await User.create({
        email: 'owner@example.com',
        password_hash: passwordHash,
        role: ROLES.OWNER,
        owner_id: 'test-owner-uuid',
        status: 'active',
      });

      // Login
      const res = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'owner@example.com', password: 'MyPassword123!' });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(ROLES.OWNER);
      expect(res.body.data.accessToken).toBeDefined();
      console.log(`  ✓ Owner logged in successfully`);
      console.log(`    - Email: owner@example.com`);
      console.log(`    - Owner ID: ${res.body.data.ownerId}`);
    });

    test('should reject wrong password', async () => {
      const passwordHash = await authService.hashPassword('CorrectPassword123!');
      await User.create({
        email: 'owner2@example.com',
        password_hash: passwordHash,
        role: ROLES.OWNER,
        status: 'active',
      });

      const res = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'owner2@example.com', password: 'WrongPassword' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      console.log(`  ✓ Wrong password correctly rejected`);
    });
  });

  // ========== اختبار 4: تحديد التطبيقات (Rate Limiting) ==========
  describe('⏱️ Rate Limiting on Auth Endpoints', () => {
    test('should allow OTP requests within limit', async () => {
      // Note: these deliberately use 3 DIFFERENT phone numbers to prove
      // this is testing the IP-based rate-limit middleware (which doesn't
      // care about phone number), not the otp.service per-phone check.
      const res1 = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone: uniquePhone() });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      console.log(`  ✓ First OTP request allowed`);

      const res2 = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone: uniquePhone() });

      expect(res2.status).toBe(200);
      console.log(`  ✓ Second OTP request allowed`);

      const res3 = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone: uniquePhone() });

      expect(res3.status).toBe(200);
      console.log(`  ✓ Third OTP request allowed (at limit)`);
    });

    test('should block OTP requests exceeding limit', async () => {
      // Make 3 requests (max) — different phones on purpose, since this
      // test targets the IP-based middleware limiter specifically, which
      // is shared across phone numbers. beforeEach() resets it fresh for
      // this test, so these 3 calls consume the full budget regardless
      // of what phone number each one uses.
      for (let i = 0; i < 3; i++) {
        await request(app)
          .post('/api/auth/request-otp')
          .send({ phone: uniquePhone() });
      }

      // 4th request (yet another distinct phone) should still be blocked —
      // proving the block is IP-based, not phone-based.
      const res = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone: uniquePhone() });

      expect(res.status).toBe(429);
      console.log(`  ✓ 4th OTP request correctly rate-limited (status 429)`);
      console.log(`    Note: Rate limiter uses IN-MEMORY storage (express-rate-limit default)`);
      console.log(`    ⚠️  For production, migrate to Redis for multi-instance deployments`);
    });
  });

  // ========== اختبار 5: إدارة الرموز ==========
  describe('🔑 Token Management', () => {
    test('should refresh access token with valid refresh token', async () => {
      const phone = uniquePhone();

      // Login to get tokens
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      const refreshToken = loginRes.body.data.refreshToken;
      const oldAccessToken = loginRes.body.data.accessToken;

      // Refresh
      const refreshRes = await request(app)
        .post('/api/auth/refresh-token')
        .send({ refreshToken });

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.data.accessToken).toBeDefined();
      expect(refreshRes.body.data.accessToken).not.toBe(oldAccessToken);
      console.log(`  ✓ Access token refreshed successfully`);
      console.log(`    - New token valid for: ${env.jwt.accessExpiry}`);
    });
  });

  // ========== اختبار 6: إلغاء الأدوار (Role Rejection) ==========
  describe('🚫 Role-Based Access Control', () => {
    test('student token should be rejected on admin-only endpoints', async () => {
      const phone = uniquePhone();

      // Get student token
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      const otpCode = otpRes.body.data._dev_code;

      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      const studentToken = loginRes.body.data.accessToken;

      // Try to access admin-only endpoint (invite-owner)
      const res = await request(app)
        .post('/api/auth/invite-owner')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ email: 'newowner@test.com', temporaryPassword: 'Pass123!' });

      expect(res.status).toBe(403);
      console.log(`  ✓ Student token correctly rejected on admin endpoint`);
      console.log(`    - Status: 403 Forbidden`);
    });
  });
});
