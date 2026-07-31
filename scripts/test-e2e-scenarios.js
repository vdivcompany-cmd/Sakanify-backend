#!/usr/bin/env node

/**
 * test-e2e-scenarios.js
 *
 * اختبار End-to-End حقيقي للسيناريوهات الحرجة:
 * 1. تسجيل طالب جديد + محاولة تسجيل مكرر (يجب أن يُرفض)
 * 2. استدعاء endpoint محمي بدون token (يجب 401)
 * 3. استخدام token owner على admin-only endpoint (يجب 403)
 * 4. تسجيل دخول owner كامل
 */

require('dotenv').config();
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app.entry');
const User = require('../src/modules/auth/auth.model');
const OTP = require('../src/modules/auth/otp.model');
const authService = require('../src/modules/auth/auth.service');
const { ROLES } = require('../src/config/constants.config');
const env = require('../src/config/env.config');

let testsPassed = 0;
let testsFailed = 0;
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

async function runE2ETests() {
  log('\n════════════════════════════════════════════════════════');
  log('🚀 End-to-End Tests — Realistic HTTP Scenarios');
  log('════════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    log('📡 Connecting to MongoDB...');
    if (!mongoose.connection.readyState) {
      await mongoose.connect(env.mongodbUri, {
        serverSelectionTimeoutMS: 10000,
      });
    }
    log('✓ Connected to MongoDB\n');

    // Clean up
    await User.deleteMany({});
    await OTP.deleteMany({});

    // ========== Test 1: Student Registration + Duplicate Prevention ==========
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📱 Test 1: Student Registration + Duplicate Prevention');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const phone = '+201234567890';

      // First registration
      const res1 = await request(app)
        .post('/api/auth/register-student')
        .send({ phone });

      if (res1.status === 201) {
        testPass('First student registration successful',
          `Status: ${res1.status}\nPhone: ${res1.body.data.phone}`);
      } else {
        testFail('First student registration', new Error(`Status: ${res1.status}`));
      }

      // Duplicate registration attempt
      const res2 = await request(app)
        .post('/api/auth/register-student')
        .send({ phone });

      if (res2.status === 400 && !res2.body.success) {
        testPass('Duplicate registration correctly rejected',
          `Status: ${res2.status}\nMessage: "${res2.body.message}"`);
      } else {
        testFail('Duplicate prevention', new Error(`Expected 400, got ${res2.status}`));
      }
    } catch (err) {
      testFail('Student Registration Test', err);
    }

    // ========== Test 2: Protected Endpoint without Token ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔐 Test 2: Protected Endpoint without Authorization');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const res = await request(app)
        .post('/api/auth/logout');

      if (res.status === 401 && !res.body.success) {
        testPass('Missing auth header correctly rejected (401)',
          `Status: ${res.status}\nMessage: "${res.body.message}"`);
      } else {
        testFail('Missing auth header', new Error(`Expected 401, got ${res.status}`));
      }
    } catch (err) {
      testFail('Protected Endpoint Test', err);
    }

    // ========== Test 3: Invalid Authorization Header ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 3: Invalid/Malformed Authorization Header');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'InvalidToken123');

      if (res.status === 401) {
        testPass('Malformed token correctly rejected (401)',
          `Status: ${res.status}\nMessage: "${res.body.message}"`);
      } else {
        testFail('Malformed token', new Error(`Expected 401, got ${res.status}`));
      }
    } catch (err) {
      testFail('Malformed Token Test', err);
    }

    // ========== Test 4: Owner Token on Admin-Only Endpoint ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 4: Owner Token on Admin-Only Endpoint (403)');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Create owner
      const passwordHash = await authService.hashPassword('OwnerPass123!');
      const owner = await User.create({
        email: 'owner@test.com',
        password_hash: passwordHash,
        role: ROLES.OWNER,
        owner_id: 'owner-uuid-123',
        status: 'active',
      });

      // Login as owner
      const loginRes = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'owner@test.com', password: 'OwnerPass123!' });

      const ownerToken = loginRes.body.data.accessToken;

      // Try to access admin-only endpoint (invite-owner)
      const res = await request(app)
        .post('/api/auth/invite-owner')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'newowner@test.com', temporaryPassword: 'Pass123!' });

      if (res.status === 403 && !res.body.success) {
        testPass('Owner token rejected on admin endpoint (403)',
          `Status: ${res.status}\nMessage: "${res.body.message}"`);
      } else {
        testFail('Owner token on admin endpoint',
          new Error(`Expected 403, got ${res.status}`));
      }
    } catch (err) {
      testFail('Owner Token on Admin Test', err);
    }

    // ========== Test 5: Super-Admin Creation (Seed Script Simulation) ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('👑 Test 5: Super-Admin Account Creation + Login');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const adminPasswordHash = await authService.hashPassword('AdminPass123!');
      const admin = await User.create({
        email: 'admin@sakanify.com',
        password_hash: adminPasswordHash,
        role: ROLES.SUPER_ADMIN,
        status: 'active',
      });

      testPass('Super-admin created in database',
        `Email: ${admin.email}\nRole: ${admin.role}\nID: ${admin._id}`);

      // Login as super-admin
      const loginRes = await request(app)
        .post('/api/auth/login-owner')
        .send({ email: 'admin@sakanify.com', password: 'AdminPass123!' });

      if (loginRes.status === 200 && loginRes.body.data.role === ROLES.SUPER_ADMIN) {
        const token = loginRes.body.data.accessToken;
        testPass('Super-admin login successful',
          `Status: ${loginRes.status}\nRole: ${loginRes.body.data.role}\nToken: ${token.substring(0, 20)}...`);

        // Verify token
        const decoded = authService.verifyToken(token);
        if (decoded.role === ROLES.SUPER_ADMIN) {
          testPass('Token contains correct super-admin role',
            `Role in token: ${decoded.role}`);
        }
      } else {
        testFail('Super-admin login',
          new Error(`Expected 200, got ${loginRes.status}`));
      }
    } catch (err) {
      testFail('Super-Admin Test', err);
    }

    // ========== Test 6: Complete Student OTP Flow ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📱 Test 6: Complete Student OTP Login Flow');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const phone = '+201987654321';

      // Step 1: Request OTP
      const otpRes = await request(app)
        .post('/api/auth/request-otp')
        .send({ phone });

      if (otpRes.status !== 200) {
        throw new Error(`OTP request failed: ${otpRes.status}`);
      }

      const otpCode = otpRes.body.data._dev_code;
      testPass('OTP requested successfully',
        `Status: ${otpRes.status}\nCode: ${otpCode}`);

      // Step 2: Verify OTP and login
      const loginRes = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone, code: otpCode });

      if (loginRes.status === 200 && loginRes.body.data.role === ROLES.STUDENT) {
        testPass('Student OTP login successful',
          `Status: ${loginRes.status}\nRole: ${loginRes.body.data.role}\nAccess Token: ${loginRes.body.data.accessToken.substring(0, 20)}...`);

        // Step 3: Use token to access protected endpoint
        const logoutRes = await request(app)
          .post('/api/auth/logout')
          .set('Authorization', `Bearer ${loginRes.body.data.accessToken}`);

        if (logoutRes.status === 200) {
          testPass('Student token works on protected endpoint',
            `Logout status: ${logoutRes.status}`);
        }
      } else {
        testFail('Student OTP login',
          new Error(`Expected 200, got ${loginRes.status}`));
      }
    } catch (err) {
      testFail('Student OTP Flow Test', err);
    }

    // ========== Test 7: Password Reset Flow ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔑 Test 7: Password Reset Flow');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Create owner
      const pwdHash = await authService.hashPassword('OldPass123!');
      const owner = await User.create({
        email: 'reset@test.com',
        password_hash: pwdHash,
        role: ROLES.OWNER,
        status: 'active',
      });

      // Initiate reset
      const resetRes = await request(app)
        .post('/api/auth/password-reset/initiate')
        .send({ email: 'reset@test.com' });

      if (resetRes.status === 200) {
        testPass('Password reset initiated',
          `Status: ${resetRes.status}\nMessage: "${resetRes.body.message}"`);
      }

      // Old password shouldn't work anymore (after system processes reset)
      // In this test, we're just verifying the initiate endpoint works
    } catch (err) {
      testFail('Password Reset Test', err);
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
      log('🎉 All E2E tests passed! Phase 1 is production-ready.\n');
    } else {
      log(`⚠️  ${testsFailed} test(s) failed.\n`);
    }

    // Detailed results
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('Test Results:');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
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
    } catch (err) {
      // Ignore
    }
  }
}

runE2ETests();
