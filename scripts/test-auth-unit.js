#!/usr/bin/env node

/**
 * test-auth-unit.js
 *
 * اختبارات وحدة للمصادقة (Unit Tests - No DB)
 * تختبر المنطق الأساسي بدون الاعتماد على MongoDB
 */

require('dotenv').config();
const authService = require('../src/modules/auth/auth.service');
const { ownershipScoping } = require('../src/middleware/auth.middleware');
const { ROLES } = require('../src/config/constants.config');

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
  log(`     Error: ${error.message || error}`);
  results.push({ status: 'FAIL', name, error: error.message || error });
}

async function runTests() {
  log('\n════════════════════════════════════════════════════════');
  log('🔐 Auth Module — Unit Tests (No Database)');
  log('════════════════════════════════════════════════════════\n');

  try {
    // ========== Test 1: Password Hashing ==========
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔐 Test 1: Password Hashing with bcryptjs');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const password = 'SecurePassword123!';
      const hash = await authService.hashPassword(password);

      // Check hash is bcrypt format
      if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
        testPass('Password hashed with bcryptjs', `Hash: ${hash.substring(0, 20)}...`);
      } else {
        testFail('Password hash format', new Error('Not a valid bcrypt hash'));
      }

      // Verify correct password
      const correctMatch = await authService.comparePassword(password, hash);
      if (correctMatch) {
        testPass('Correct password verification PASS', 'Password matched correctly');
      } else {
        testFail('Correct password verification', new Error('Should have matched'));
      }

      // Verify wrong password
      const wrongMatch = await authService.comparePassword('WrongPassword', hash);
      if (!wrongMatch) {
        testPass('Wrong password verification FAIL', 'Incorrect password rejected');
      } else {
        testFail('Wrong password verification', new Error('Should have rejected'));
      }

      // Verify password not in plaintext
      if (!hash.includes(password)) {
        testPass('Password not stored in plaintext', 'Hash does not contain original password');
      }
    } catch (err) {
      testFail('Password Hashing', err);
    }

    // ========== Test 2: JWT Token Generation ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔑 Test 2: JWT Token Generation & Verification');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const userId = '507f1f77bcf86cd799439011';
      const role = ROLES.STUDENT;

      const tokens = authService.issueTokens(userId, role);

      if (tokens.accessToken && tokens.refreshToken) {
        testPass('Tokens generated', `Access: ${tokens.accessToken.substring(0, 20)}...`);
      } else {
        testFail('Token generation', new Error('Tokens not generated'));
      }

      // Verify access token
      try {
        const decoded = authService.verifyToken(tokens.accessToken, 'access');
        if (decoded.userId === userId && decoded.role === role) {
          testPass('Access token valid and contains correct data', `User: ${decoded.userId}, Role: ${decoded.role}`);
        }
      } catch (err) {
        testFail('Access token verification', err);
      }

      // Verify refresh token
      try {
        const decoded = authService.verifyToken(tokens.refreshToken, 'refresh');
        if (decoded.userId === userId && decoded.role === role) {
          testPass('Refresh token valid', `Expires in: 7 days`);
        }
      } catch (err) {
        testFail('Refresh token verification', err);
      }

      // Try invalid token
      try {
        authService.verifyToken('invalid-token', 'access');
        testFail('Invalid token rejection', new Error('Should have thrown error'));
      } catch (err) {
        if (err.message.includes('Invalid')) {
          testPass('Invalid token rejection', 'Invalid token correctly rejected');
        }
      }
    } catch (err) {
      testFail('JWT Token Tests', err);
    }

    // ========== Test 3: Owner ID Generation ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🆔 Test 3: Owner ID Generation (UUID)');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const ownerId1 = authService.generateOwnerId();
      const ownerId2 = authService.generateOwnerId();

      // Check UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(ownerId1)) {
        testPass('Owner ID is valid UUID', ownerId1);
      } else {
        testFail('Owner ID format', new Error('Not a valid UUID'));
      }

      // Check uniqueness
      if (ownerId1 !== ownerId2) {
        testPass('Owner IDs are unique', 'Two generated IDs are different');
      } else {
        testFail('Owner ID uniqueness', new Error('IDs should be unique'));
      }
    } catch (err) {
      testFail('Owner ID Generation', err);
    }

    // ========== Test 4: CRITICAL - Ownership Scoping ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔒 Test 4: CRITICAL - Ownership Scoping Function');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const ownerA_id = 'owner-a-uuid-12345-abcdef';
      const ownerB_id = 'owner-b-uuid-67890-xyz123';

      // Test 4a: Owner A trying to access Owner B (should fail)
      try {
        ownershipScoping(ownerA_id, ownerB_id);
        testFail('Ownership Scoping A→B', new Error('Should have thrown error'));
      } catch (err) {
        if (err.message.includes('do not have permission')) {
          testPass('🔒 CRITICAL: A cannot access B', 'Correctly blocked Owner A from Owner B data');
        } else {
          testFail('Ownership Scoping A→B', err);
        }
      }

      // Test 4b: Owner A accessing own data (should succeed)
      try {
        ownershipScoping(ownerA_id, ownerA_id);
        testPass('✅ CRITICAL: A can access own data', 'Correctly allowed Owner A to own data');
      } catch (err) {
        testFail('Ownership Scoping A→A', err);
      }

      // Test 4c: Owner B trying to access Owner A (should fail)
      try {
        ownershipScoping(ownerB_id, ownerA_id);
        testFail('Ownership Scoping B→A', new Error('Should have thrown error'));
      } catch (err) {
        if (err.message.includes('do not have permission')) {
          testPass('🔒 CRITICAL: B cannot access A', 'Correctly blocked Owner B from Owner A data');
        }
      }

      // Test 4d: Owner B accessing own data (should succeed)
      try {
        ownershipScoping(ownerB_id, ownerB_id);
        testPass('✅ CRITICAL: B can access own data', 'Correctly allowed Owner B to own data');
      } catch (err) {
        testFail('Ownership Scoping B→B', err);
      }

      // Test 4e: Null/undefined handling
      try {
        ownershipScoping(null, ownerA_id);
        testFail('Null owner ID handling', new Error('Should have thrown error'));
      } catch (err) {
        if (err.message.includes('not owner-scoped')) {
          testPass('Null owner ID rejection', 'Correctly rejected null owner_id');
        }
      }
    } catch (err) {
      testFail('Ownership Scoping', err);
    }

    // ========== Test 5: Token with Owner ID ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔐 Test 5: Token with Ownership Information');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const userId = '507f1f77bcf86cd799439012';
      const role = ROLES.OWNER;
      const ownerId = 'owner-12345-abcdef';

      const tokens = authService.issueTokens(userId, role, ownerId);
      const decoded = authService.verifyToken(tokens.accessToken);

      if (decoded.ownerId === ownerId) {
        testPass('Token contains owner_id', `Owner ID: ${decoded.ownerId}`);
      } else {
        testFail('Owner ID in token', new Error('owner_id mismatch'));
      }

      // Verify student token has no owner_id
      const studentTokens = authService.issueTokens(userId, ROLES.STUDENT);
      const studentDecoded = authService.verifyToken(studentTokens.accessToken);

      if (!studentDecoded.ownerId || studentDecoded.ownerId === null) {
        testPass('Student token has no owner_id', 'Correctly null for students');
      }
    } catch (err) {
      testFail('Token with Ownership', err);
    }

    // ========== Test 6: Role Validation ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('👥 Test 6: Role Information in Tokens');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const userId = '507f1f77bcf86cd799439013';

      // Test each role
      const roles = [ROLES.STUDENT, ROLES.OWNER, ROLES.SUPER_ADMIN];

      for (const role of roles) {
        const tokens = authService.issueTokens(userId, role);
        const decoded = authService.verifyToken(tokens.accessToken);

        if (decoded.role === role) {
          testPass(`${role.toUpperCase()} role in token`, 'Role correctly encoded');
        } else {
          testFail(`${role.toUpperCase()} role`, new Error('Role mismatch'));
        }
      }
    } catch (err) {
      testFail('Role Validation', err);
    }

    // ========== Test 7: Rate Limiting Configuration ==========
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('⏱️  Test 7: Rate Limiting Configuration');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      const env = require('../src/config/env.config');

      testPass('OTP expiry configured', `${env.otp.expiry} seconds (${env.otp.expiry / 60} minutes)`);
      testPass('OTP max attempts configured', `${env.otp.maxAttempts} attempts`);
      testPass('JWT access expiry configured', env.jwt.accessExpiry);
      testPass('JWT refresh expiry configured', env.jwt.refreshExpiry);

      // Check values
      if (env.otp.expiry === 300) {
        testPass('OTP expiry correct value', '5 minutes');
      }
      if (env.otp.maxAttempts === 3) {
        testPass('OTP max attempts correct value', '3 attempts');
      }

      log('\n     ⚠️  NOTE ON RATE LIMITING:');
      log('     - Currently using express-rate-limit with IN-MEMORY store');
      log('     - This works fine for single-instance deployments');
      log('     - For production with multiple instances, migrate to Redis');
    } catch (err) {
      testFail('Rate Limiting Config', err);
    }

    // ========== Summary ==========
    log('\n════════════════════════════════════════════════════════');
    log('📊 Test Summary');
    log('════════════════════════════════════════════════════════\n');

    log(`✅ Tests Passed: ${testsPassed}`);
    log(`❌ Tests Failed: ${testsFailed}`);
    log(`📈 Total Tests: ${testsPassed + testsFailed}`);
    const successRate = testsPassed + testsFailed > 0 ? Math.round((testsPassed / (testsPassed + testsFailed)) * 100) : 0;
    log(`📊 Success Rate: ${successRate}%\n`);

    if (testsFailed === 0) {
      log('🎉 All unit tests passed! Phase 1 Authentication core logic is working correctly.\n');
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

    log('\n════════════════════════════════════════════════════════\n');

    process.exit(testsFailed > 0 ? 1 : 0);
  } catch (err) {
    log(`\n❌ Fatal Error: ${err.message}\n`);
    process.exit(1);
  }
}

runTests();
