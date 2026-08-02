#!/usr/bin/env node

/**
 * test-e2e-final.js
 *
 * اختبار End-to-End نهائي شامل:
 * - استخدام MongoDB Memory Server (محاكاة قاعدة بيانات MongoDB محلية)
 * - اختبار جميع السيناريوهات الحرجة
 * - توثيق الـ HTTP responses الفعلية
 */

require('dotenv').config();
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app.entry');
const User = require('../src/modules/auth/auth.model');
const OTP = require('../src/modules/auth/otp.model');
const authService = require('../src/modules/auth/auth.service');
const otpService = require('../src/modules/auth/otp.service');
const { ROLES } = require('../src/config/constants.config');

let mongoServer;
let testsPassed = 0;
let testsFailed = 0;
const responses = [];
const results = [];

function log(msg) {
  console.log(msg);
}

function testPass(name, details = '') {
  testsPassed++;
  log(`  ✅ ${name}`);
  if (details) {
    details.split('\n').forEach(line => log(`     ${line}`));
  }
  results.push({ status: 'PASS', name });
}

function testFail(name, error) {
  testsFailed++;
  log(`  ❌ ${name}`);
  log(`     Error: ${error.message || error}`);
  results.push({ status: 'FAIL', name, error: error.message || error });
}

function logResponse(endpoint, method, status, body) {
  responses.push({
    endpoint,
    method,
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  });
}

async function runE2ETests() {
  log('\n════════════════════════════════════════════════════════');
  log('🚀 End-to-End Tests — Final Validation (With In-Memory DB)');
  log('════════════════════════════════════════════════════════\n');

  try {
    // Start MongoDB Memory Server
    log('📡 Starting MongoDB Memory Server...');
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();

    await mongoose.connect(mongoUri);
    log('✓ Connected to in-memory MongoDB\n');

    // ========== Test 1: Student Registration + Duplicate Prevention ==========
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📱 Test 1: Student Registration + Duplicate Prevention');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const phone1 = '+201234567890';

    // First registration
    let res = await request(app)
      .post('/api/auth/register-student')
      .send({ phone: phone1 });

    logResponse('/api/auth/register-student', 'POST', res.status, res.body);

    if (res.status === 201) {
      testPass('✅ First registration successful (201)',
        `Response: ${res.body.message}`);
    } else {
      testFail('First registration', new Error(`Status: ${res.status}`));
    }

    // Duplicate registration attempt
    res = await request(app)
      .post('/api/auth/register-student')
      .send({ phone: phone1 });

    logResponse('/api/auth/register-student (duplicate)', 'POST', res.status, res.body);

    if (res.status === 400 && !res.body.success) {
      testPass('✅ Duplicate registration blocked (400)',
        `Message: "${res.body.message}"`);
    } else {
      testFail('Duplicate prevention', new Error(`Expected 400, got ${res.status}`));
    }

    // ========== Test 2: Protected Endpoint without Token ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔐 Test 2: Protected Endpoint without Authorization');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res = await request(app)
      .post('/api/auth/logout');

    logResponse('/api/auth/logout (no auth)', 'POST', res.status, res.body);

    if (res.status === 401 && !res.body.success) {
      testPass('✅ Missing auth correctly rejected (401)',
        `Message: "${res.body.message}"`);
    } else {
      testFail('Missing auth header', new Error(`Expected 401, got ${res.status}`));
    }

    // ========== Test 3: Invalid/Malformed Authorization ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 3: Malformed Authorization Header');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'InvalidToken123');

    logResponse('/api/auth/logout (malformed)', 'POST', res.status, res.body);

    if (res.status === 401) {
      testPass('✅ Malformed token rejected (401)',
        `Message: "${res.body.message}"`);
    } else {
      testFail('Malformed token', new Error(`Expected 401, got ${res.status}`));
    }

    // ========== Test 4: Owner Token on Admin-Only Endpoint ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 4: Owner Token on Admin-Only Endpoint (403)');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Create and login owner
    const ownerPwdHash = await authService.hashPassword('OwnerPass123!');
    await User.create({
      email: 'owner@test.com',
      password_hash: ownerPwdHash,
      role: ROLES.OWNER,
      owner_id: 'owner-uuid-123',
      status: 'active',
    });

    res = await request(app)
      .post('/api/auth/login-owner')
      .send({ email: 'owner@test.com', password: 'OwnerPass123!' });

    const ownerToken = res.body.data.accessToken;

    // Try admin-only endpoint with owner token
    res = await request(app)
      .post('/api/auth/invite-owner')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'newowner@test.com', temporaryPassword: 'Pass123!' });

    logResponse('/api/auth/invite-owner (owner token)', 'POST', res.status, res.body);

    if (res.status === 403 && !res.body.success) {
      testPass('✅ Owner token rejected on admin endpoint (403)',
        `Message: "${res.body.message}"`);
    } else {
      testFail('Owner token on admin endpoint',
        new Error(`Expected 403, got ${res.status}`));
    }

    // ========== Test 5: Super-Admin Creation & Login ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('👑 Test 5: Super-Admin Account Creation & Login');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const adminPwdHash = await authService.hashPassword('AdminPass123!');
    const admin = await User.create({
      email: 'admin@sakanify.com',
      password_hash: adminPwdHash,
      role: ROLES.SUPER_ADMIN,
      status: 'active',
    });

    testPass('✅ Super-admin created in database',
      `Email: ${admin.email}\nRole: ${admin.role}`);

    res = await request(app)
      .post('/api/auth/login-owner')
      .send({ email: 'admin@sakanify.com', password: 'AdminPass123!' });

    logResponse('/api/auth/login-owner (admin)', 'POST', res.status, res.body);

    if (res.status === 200 && res.body.data.role === ROLES.SUPER_ADMIN) {
      testPass('✅ Super-admin login successful (200)',
        `Role: ${res.body.data.role}\nToken: ${res.body.data.accessToken.substring(0, 20)}...`);
    } else {
      testFail('Super-admin login', new Error(`Status: ${res.status}`));
    }

    // ========== Test 6: Complete Student OTP Flow ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📱 Test 6: Complete Student OTP Login Flow');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const phone2 = '+201987654321';

    // Request OTP
    res = await request(app)
      .post('/api/auth/request-otp')
      .send({ phone: phone2 });

    logResponse('/api/auth/request-otp', 'POST', res.status, res.body);

    if (res.status !== 200) {
      throw new Error(`OTP request failed: ${res.status}`);
    }

    // SEC-001 fix: the OTP code is no longer part of the response body —
    // read it back from the store via the test-only accessor instead.
    const otpCode = await otpService.__getLastOtpForPhone(phone2);
    testPass('✅ OTP requested successfully (200)',
      `Code: ${otpCode}`);

    // Verify OTP and login
    res = await request(app)
      .post('/api/auth/verify-otp')
      .send({ phone: phone2, code: otpCode });

    logResponse('/api/auth/verify-otp', 'POST', res.status, res.body);

    if (res.status === 200 && res.body.data.role === ROLES.STUDENT) {
      const studentToken = res.body.data.accessToken;
      testPass('✅ Student OTP login successful (200)',
        `Role: ${res.body.data.role}\nToken: ${studentToken.substring(0, 20)}...`);

      // Use token on protected endpoint
      res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${studentToken}`);

      logResponse('/api/auth/logout (with valid token)', 'POST', res.status, res.body);

      if (res.status === 200) {
        testPass('✅ Student token works on protected endpoint (200)',
          `Message: "${res.body.message}"`);
      }
    } else {
      testFail('Student OTP login', new Error(`Status: ${res.status}`));
    }

    // ========== Test 7: Token Refresh ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔄 Test 7: Token Refresh Flow');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const phone3 = '+201555555555';

    res = await request(app)
      .post('/api/auth/request-otp')
      .send({ phone: phone3 });

    const otpCode2 = await otpService.__getLastOtpForPhone(phone3);

    res = await request(app)
      .post('/api/auth/verify-otp')
      .send({ phone: phone3, code: otpCode2 });

    const refreshToken = res.body.data.refreshToken;

    res = await request(app)
      .post('/api/auth/refresh-token')
      .send({ refreshToken });

    logResponse('/api/auth/refresh-token', 'POST', res.status, res.body);

    if (res.status === 200 && res.body.data.accessToken) {
      testPass('✅ Token refreshed successfully (200)',
        `New Token: ${res.body.data.accessToken.substring(0, 20)}...`);
    } else {
      testFail('Token refresh', new Error(`Status: ${res.status}`));
    }

    // ========== Summary ==========
    log('\n════════════════════════════════════════════════════════');
    log('📊 E2E Test Summary');
    log('════════════════════════════════════════════════════════\n');

    log(`✅ Tests Passed: ${testsPassed}`);
    log(`❌ Tests Failed: ${testsFailed}`);
    log(`📈 Total Tests: ${testsPassed + testsFailed}`);
    const successRate = testsPassed + testsFailed > 0 ?
      Math.round((testsPassed / (testsPassed + testsFailed)) * 100) : 0;
    log(`📊 Success Rate: ${successRate}%\n`);

    if (testsFailed === 0) {
      log('🎉 ALL E2E TESTS PASSED! Phase 1 is production-ready.\n');
    }

    // HTTP Responses Log
    log('════════════════════════════════════════════════════════');
    log('📋 HTTP Responses Log');
    log('════════════════════════════════════════════════════════\n');

    responses.forEach((resp, i) => {
      log(`[${i + 1}] ${resp.method} ${resp.endpoint}`);
      log(`    Status: ${resp.status}`);
      log(`    Response: ${resp.body.substring(0, 150)}...`);
      log('');
    });

    // Detailed results
    log('═══════════════════════════════════════════════════════════');
    log('✅ Test Results:');
    log('═══════════════════════════════════════════════════════════');
    results.forEach((r) => {
      const icon = r.status === 'PASS' ? '✅' : '❌';
      log(`${icon} ${r.name}`);
    });

    log('\n════════════════════════════════════════════════════════\n');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    log(`\n❌ Fatal Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    try {
      if (mongoose.connection.readyState) {
        await mongoose.disconnect();
      }
      if (mongoServer) {
        await mongoServer.stop();
      }
    } catch (err) {
      // Ignore
    }
  }
}

runE2ETests();
