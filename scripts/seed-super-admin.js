#!/usr/bin/env node

/**
 * scripts/seed-super-admin.js
 *
 * ONE-TIME SEED SCRIPT for creating the first Super-Admin account.
 * This is NOT exposed via any API endpoint — it runs locally/in CI only.
 *
 * Usage:
 *   node scripts/seed-super-admin.js \
 *     --email="admin@sakanify.com" \
 *     --password="ChangeMe123!"
 *
 * IMPORTANT SECURITY NOTES:
 * - This script should ONLY run in controlled environments (local dev, CI/CD)
 * - Never commit real credentials
 * - The created super-admin MUST change password on first login
 * - There is NO API endpoint to create additional super-admins from Phase 1
 * - To create more super-admins, use the CLI tool (built in Phase 7)
 */

const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs');
require('dotenv').config();

// Import User model
const User = require('../src/modules/auth/auth.model');
const env = require('../src/config/env.config');
const { ROLES } = require('../src/config/constants.config');

async function seedSuperAdmin() {
  // Get email and password from environment or command-line args
  const email = (process.env.SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';

  // Validate inputs
  if (!email || !email.includes('@')) {
    console.error('❌ Error: Valid email is required');
    process.exit(1);
  }

  if (!password || password.length < 8) {
    console.error('❌ Error: Password must be at least 8 characters');
    process.exit(1);
  }

  try {
    // Connect to database
    console.log('[Seed] Connecting to MongoDB...');
    await mongoose.connect(env.mongodbUri);
    console.log('✓ Connected to MongoDB');

    // Check if super-admin already exists
    const existingAdmin = await User.findOne({
      role: ROLES.SUPER_ADMIN,
    });

    if (existingAdmin) {
      console.warn('⚠️  Warning: A super-admin account already exists.');
      console.log(`   Email: ${existingAdmin.email}`);
      console.log('   Aborting to prevent accidental overwrite.');
      process.exit(0);
    }

    // Check if email is already in use
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.error(`❌ Error: Email "${email}" is already in use`);
      process.exit(1);
    }

    // Hash password with bcryptjs
    console.log('[Seed] Hashing password...');
    const salt = await bcryptjs.genSalt(10);
    const passwordHash = await bcryptjs.hash(password, salt);

    // Create super-admin account
    console.log('[Seed] Creating super-admin account...');
    const superAdmin = await User.create({
      email,
      password_hash: passwordHash,
      role: ROLES.SUPER_ADMIN,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    });

    console.log('✅ Super-admin account created successfully!');
    console.log(`\n   Email: ${superAdmin.email}`);
    console.log(`   Role: ${superAdmin.role}`);
    console.log(`   Status: ${superAdmin.status}`);
    console.log(`   ID: ${superAdmin._id}`);
    console.log('\n⚠️  IMPORTANT:');
    console.log('   1. Store these credentials securely');
    console.log('   2. Change password on first login');
    console.log('   3. This account has access to ALL data (use carefully)');
    console.log('   4. Enable 2FA when available (future phase)');
    console.log('\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error during seed:', error.message);
    process.exit(1);
  } finally {
    // Disconnect from database
    try {
      await mongoose.disconnect();
    } catch (err) {
      // Ignore disconnect errors
    }
  }
}

// Run seed
seedSuperAdmin();
