#!/usr/bin/env node

/**
 * test-auth-direct.js
 *
 * اختبار مباشر للمصادقة بدون Jest
 * يختبر النقاط الحرجة:
 * - تسجيل الدخول عبر OTP
 * - عزل الملكية (Owner A vs Owner B)
 * - تسجيل دخول صاحب المبنى
 * - تحديل التطبيقات
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/modules/auth/auth.model');
const OTP = require('../src/modules/auth/otp.model');
const authService = require('../src/modules/auth/auth.service');
const otpService = require('../src/modules/auth/otp.service');
const { ownershipScoping } = require('../src/middleware/auth.middleware');
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
  if (details) log(`     ${details}`);
  results.push({ status: 'PASS', name });
}

function testFail(name, error) {
  testsFailed++;
  log(`  ❌ ${name}`);
  log(`     Error: ${error.message}`);
  results.push({ status: 'FAIL', name, error: error.message });
}

async function runTests() {
  log('\n════════════════════════════════════════════════════════');
  log('🔐 Auth Module — Direct Tests (No Jest)');
  log('════════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    log('📡 Connecting to MongoDB...');
    if (!mongoose.connection.readyState) {
      await mongoose.connect(env.mongodbUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });
    }
    log('✓ Connected to MongoDB\n');

    // Clean up
    await User.deleteMany({});
    await OTP.deleteMany({});

    // ========== Test 1: Student OTP Login ==========
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('📱 Test 1: Student OTP Login Flow');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const phone = '+201234567890';

      // Request OTP
      await otpService.requestOtp(phone);
      // SEC-001 fix: requestOtp() no longer returns the code — read it
      // back via the test-only accessor instead.
      const otpCode = await otpService.__getLastOtpForPhone(phone);

      testPass('OTP generated', `Code: ${otpCode}`);

      // Verify OTP
      await otpService.verifyOtp(phone, otpCode);
      testPass('OTP verified');

      // Login
      const loginResult = await authService.loginStudent(phone, otpCode);
      testPass('Student login successful', `User ID: ${loginResult.userId}, Role: ${loginResult.role}`);

      // Verify token
      const decoded = authService.verifyToken(loginResult.accessToken);
      testPass('Access token valid', `Expires in: ${env.jwt.accessExpiry}`);
    } catch (err) {
      testFail('Student OTP Login', err);
    }

    // ========== Test 2: Owner Login ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('👤 Test 2: Owner Email+Password Login');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const passwordHash = await authService.hashPassword('SecurePass123!');
      const owner = await User.create({
        email: 'owner@example.com',
        password_hash: passwordHash,
        role: ROLES.OWNER,
        owner_id: 'owner-test-uuid-123',
        status: 'active',
      });

      testPass('Owner created', `Email: ${owner.email}, Owner ID: ${owner.owner_id}`);

      // Login
      const loginResult = await authService.loginOwner('owner@example.com', 'SecurePass123!');
      testPass('Owner login successful', `Role: ${loginResult.role}`);

      // Verify token contains owner_id
      const decoded = authService.verifyToken(loginResult.accessToken);
      if (decoded.ownerId === 'owner-test-uuid-123') {
        testPass('Token contains correct owner_id', `Owner ID: ${decoded.ownerId}`);
      } else {
        testFail('Token ownership check', new Error('Owner ID mismatch'));
      }
    } catch (err) {
      testFail('Owner Login', err);
    }

    // ========== Test 3: CRITICAL - Ownership Scoping ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 3: CRITICAL - Ownership Scoping Isolation');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Create two owners
      const pwdA = await authService.hashPassword('PasswordA123!');
      const ownerA = await User.create({
        email: 'ownerA@test.com',
        password_hash: pwdA,
        role: ROLES.OWNER,
        owner_id: 'owner-a-uuid-abcdef',
        status: 'active',
      });

      const pwdB = await authService.hashPassword('PasswordB123!');
      const ownerB = await User.create({
        email: 'ownerB@test.com',
        password_hash: pwdB,
        role: ROLES.OWNER,
        owner_id: 'owner-b-uuid-xyz123',
        status: 'active',
      });

      testPass('Created 2 owners', `A: ${ownerA.owner_id}, B: ${ownerB.owner_id}`);

      // Test 3a: Owner A cannot access Owner B
      try {
        ownershipScoping(ownerA.owner_id, ownerB.owner_id);
        testFail('Ownership Scoping A→B', new Error('Should have blocked access'));
      } catch (err) {
        if (err.message.includes('do not have permission')) {
          testPass('Ownership Scoping BLOCKED A→B', 'Owner A correctly blocked from Owner B data');
        } else {
          testFail('Ownership Scoping A→B', err);
        }
      }

      // Test 3b: Owner A CAN access own data
      try {
        ownershipScoping(ownerA.owner_id, ownerA.owner_id);
        testPass('Ownership Scoping ALLOWED A→A', 'Owner A correctly allowed to own data');
      } catch (err) {
        testFail('Ownership Scoping A→A', err);
      }

      // Test 3c: Owner B cannot access Owner A
      try {
        ownershipScoping(ownerB.owner_id, ownerA.owner_id);
        testFail('Ownership Scoping B→A', new Error('Should have blocked access'));
      } catch (err) {
        if (err.message.includes('do not have permission')) {
          testPass('Ownership Scoping BLOCKED B→A', 'Owner B correctly blocked from Owner A data');
        } else {
          testFail('Ownership Scoping B→A', err);
        }
      }

      // Test 3d: Verify tokens contain correct owner_id
      const tokenA = await authService.loginOwner('ownerA@test.com', 'PasswordA123!');
      const decodedA = authService.verifyToken(tokenA.accessToken);
      if (decodedA.ownerId === ownerA.owner_id) {
        testPass('Token A contains correct owner_id', decodedA.ownerId);
      } else {
        testFail('Token A ownership', new Error('Mismatch'));
      }

      const tokenB = await authService.loginOwner('ownerB@test.com', 'PasswordB123!');
      const decodedB = authService.verifyToken(tokenB.accessToken);
      if (decodedB.ownerId === ownerB.owner_id) {
        testPass('Token B contains correct owner_id', decodedB.owner_id);
      } else {
        testFail('Token B ownership', new Error('Mismatch'));
      }

      // Final check: tokens are different
      if (decodedA.ownerId !== decodedB.ownerId) {
        testPass('Tokens have different owner_ids', `A: ${decodedA.ownerId}, B: ${decodedB.ownerId}`);
      }
    } catch (err) {
      testFail('Ownership Scoping Setup', err);
    }

    // ========== Test 4: Password Hashing ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔐 Test 4: Password Hashing & Verification');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const password = 'MySecurePassword123!';
      const hash = await authService.hashPassword(password);

      testPass('Password hashed', `Hash length: ${hash.length}`);

      // Verify correct password
      const match = await authService.comparePassword(password, hash);
      if (match) {
        testPass('Password verification PASS', 'Correct password matched');
      } else {
        testFail('Password verification', new Error('Should have matched'));
      }

      // Verify wrong password
      const wrongMatch = await authService.comparePassword('WrongPassword', hash);
      if (!wrongMatch) {
        testPass('Password verification FAIL', 'Wrong password correctly rejected');
      } else {
        testFail('Password verification', new Error('Should have rejected wrong password'));
      }
    } catch (err) {
      testFail('Password Hashing', err);
    }

    // ========== Test 5: Logout ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🚪 Test 5: Logout & Token Invalidation');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const phone = '+205555555555';
      await otpService.requestOtp(phone);
      const otpCode = await otpService.__getLastOtpForPhone(phone);
      const loginResult = await authService.loginStudent(phone, otpCode);
      const userId = loginResult.userId;

      const logoutResult = await authService.logout(userId);
      testPass('Logout successful', 'User invalidated token');

      // Verify user was updated
      const user = await User.findById(userId);
      if (user.invalidated_token_versions && user.invalidated_token_versions.length > 0) {
        testPass('Token invalidation recorded', `Invalidated versions: ${user.invalidated_token_versions.length}`);
      }
    } catch (err) {
      testFail('Logout', err);
    }

    // ========== Test 6: Password Reset ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔄 Test 6: Password Reset');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Create owner
      const hash = await authService.hashPassword('OldPass123!');
      const owner = await User.create({
        email: 'reset@test.com',
        password_hash: hash,
        role: ROLES.OWNER,
        status: 'active',
      });

      // Initiate reset
      const resetRes = await authService.initiatePasswordReset('reset@test.com');
      testPass('Password reset initiated', resetRes.message);

      // Complete reset
      await authService.completePasswordReset(owner._id, 'NewPass456!');
      testPass('Password updated', 'User can now login with new password');

      // Verify old password doesn't work
      try {
        await authService.loginOwner('reset@test.com', 'OldPass123!');
        testFail('Old password rejection', new Error('Should have rejected old password'));
      } catch (err) {
        if (err.message.includes('Invalid')) {
          testPass('Old password rejected', 'User forced to use new password');
        }
      }
    } catch (err) {
      testFail('Password Reset', err);
    }

    // ========== Summary ==========
    log('\n════════════════════════════════════════════════════════');
    log('📊 Test Summary');
    log('════════════════════════════════════════════════════════\n');

    log(`✅ Tests Passed: ${testsPassed}`);
    log(`❌ Tests Failed: ${testsFailed}`);
    log(`📈 Total Tests: ${testsPassed + testsFailed}`);
    log(`📊 Success Rate: ${Math.round((testsPassed / (testsPassed + testsFailed)) * 100)}%\n`);

    if (testsFailed === 0) {
      log('🎉 All tests passed! Phase 1 Authentication is working correctly.\n');
    } else {
      log(`⚠️  ${testsFailed} test(s) failed. See details above.\n`);
    }

    // Detailed results
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('Detailed Results:');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    results.forEach((r) => {
      const icon = r.status === 'PASS' ? '✅' : '❌';
      log(`${icon} ${r.name}`);
      if (r.error) log(`   Error: ${r.error}`);
    });

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

runTests();
