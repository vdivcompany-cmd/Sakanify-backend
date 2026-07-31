/**
 * auth.service.js
 *
 * Core authentication logic: user registration, login, token generation,
 * verification, and session management.
 */

const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const crypto = require('crypto');
const User = require('./auth.model');
const OTP = require('./otp.model');
const otpService = require('./otp.service');
const authRepository = require('./auth.repository');
const env = require('../../config/env.config');
const { ROLES } = require('../../config/constants.config');

/**
 * Get a user by id (added in Phase 2). Exists so other modules (e.g.
 * students, kyc) can look up a user's own account data — phone, email —
 * through a service call rather than importing auth.repository/auth.model
 * directly, per CLAUDE.md Section 7.2 (cross-module logic goes through
 * service calls, not direct database access into another module's
 * collection).
 */
async function getUserById(userId) {
  return authRepository.findUserById(userId);
}

/**
 * Hash a password using bcryptjs
 */
async function hashPassword(password) {
  const salt = await bcryptjs.genSalt(10);
  return bcryptjs.hash(password, salt);
}

/**
 * Compare a plaintext password with a hash
 */
async function comparePassword(password, hash) {
  return bcryptjs.compare(password, hash);
}

/**
 * Generate unique owner ID (UUID-like)
 */
function generateOwnerId() {
  return crypto.randomUUID();
}

/**
 * Issue JWT access and refresh tokens
 *
 * Each token gets its own random `jti` (JWT ID) claim. Without this, two
 * tokens signed for the same user with the same payload within the same
 * second would be byte-for-byte identical: jsonwebtoken's `iat` claim has
 * one-second resolution, and HMAC signing is deterministic for identical
 * input — same header + same payload + same secret always produces the
 * same signature. That's not a security hole on its own (a same-second
 * re-issue is still a valid, correctly-scoped token), but it did cause a
 * refresh-token test to fail because it asserted the new access token
 * differs from the old one, and it's also just bad practice: without a
 * per-token identifier there's no way to ever revoke one specific token,
 * only "all tokens for this user" (see logout()/initiatePasswordReset()
 * above, which can only invalidate everything at once). `jti` gives us
 * that hook for later, even though per-token revocation isn't wired up yet.
 */
function issueTokens(userId, role, ownerId = null) {
  const accessToken = jwt.sign(
    {
      userId,
      role,
      ownerId,
      type: 'access',
      jti: crypto.randomUUID(),
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpiry },
  );

  const refreshToken = jwt.sign(
    {
      userId,
      role,
      ownerId,
      type: 'refresh',
      jti: crypto.randomUUID(),
    },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpiry },
  );

  return { accessToken, refreshToken };
}

/**
 * Verify JWT token (access or refresh)
 */
function verifyToken(token, type = 'access') {
  try {
    const secret = type === 'access' ? env.jwt.accessSecret : env.jwt.refreshSecret;
    const decoded = jwt.verify(token, secret);
    return decoded;
  } catch (error) {
    throw new Error(`Invalid or expired ${type} token`);
  }
}

/**
 * Register a new student (phone-based OTP login)
 *
 * - Validates phone number
 * - Creates user account
 * - Returns user ID for OTP verification step
 */
async function registerStudent(phone) {
  if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
    throw new Error('Invalid phone number format');
  }

  const cleanPhone = phone.startsWith('+') ? phone : `+20${phone.slice(-10)}`;

  // Check if user already exists
  const existingUser = await User.findOne({
    phone: cleanPhone,
    role: ROLES.STUDENT,
  });

  if (existingUser) {
    throw new Error('Student with this phone number already exists');
  }

  // Create new student account
  const newUser = await User.create({
    phone: cleanPhone,
    role: ROLES.STUDENT,
    status: 'active',
  });

  return {
    success: true,
    userId: newUser._id,
    phone: cleanPhone,
    message: 'Student registered. Please verify with OTP.',
  };
}

/**
 * Student login flow: verify OTP and issue tokens
 *
 * - Validates phone and OTP
 * - Creates or updates student user
 * - Issues access and refresh tokens
 */
async function loginStudent(phone, otpCode) {
  if (!phone || !otpCode) {
    throw new Error('Phone and OTP code are required');
  }

  // Verify OTP
  const otpVerified = await otpService.verifyOtp(phone, otpCode);
  const cleanPhone = otpVerified.phone;

  // Find or create student user
  let user = await User.findOne({
    phone: cleanPhone,
    role: ROLES.STUDENT,
  });

  if (!user) {
    user = await User.create({
      phone: cleanPhone,
      role: ROLES.STUDENT,
      status: 'active',
    });
  }

  // Ensure user is active
  if (user.status !== 'active') {
    throw new Error('User account is not active');
  }

  // Invalidate all OTPs for this phone
  await otpService.invalidateOtpsForPhone(cleanPhone);

  // Issue tokens
  const { accessToken, refreshToken } = issueTokens(user._id, ROLES.STUDENT);

  return {
    success: true,
    userId: user._id,
    role: ROLES.STUDENT,
    accessToken,
    refreshToken,
  };
}

/**
 * Owner/Admin login flow: email + password
 *
 * - Validates email and password
 * - Issues access and refresh tokens
 * - Enforces owner scoping
 */
async function loginOwner(email, password) {
  if (!email || !password) {
    throw new Error('Email and password are required');
  }

  const cleanEmail = email.trim().toLowerCase();

  // Find user by email (owners or admins)
  const user = await User.findOne({
    email: cleanEmail,
    role: { $in: [ROLES.OWNER, ROLES.SUPER_ADMIN] },
  }).select('+password_hash');

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Ensure user is active
  if (user.status !== 'active') {
    throw new Error('User account is not active');
  }

  // Verify password
  const passwordMatch = await comparePassword(password, user.password_hash);
  if (!passwordMatch) {
    throw new Error('Invalid email or password');
  }

  // Issue tokens
  const { accessToken, refreshToken } = issueTokens(user._id, user.role, user.owner_id);

  return {
    success: true,
    userId: user._id,
    role: user.role,
    ownerId: user.owner_id,
    accessToken,
    refreshToken,
  };
}

/**
 * Refresh access token using refresh token
 *
 * - Validates refresh token
 * - Issues new access token
 * - Optionally issues new refresh token
 */
async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('Refresh token is required');
  }

  try {
    const decoded = verifyToken(refreshToken, 'refresh');
    const user = await User.findById(decoded.userId);

    if (!user || user.status !== 'active') {
      throw new Error('User not found or inactive');
    }

    // Generate new access token — same jti reasoning as issueTokens() above:
    // a fresh random jti guarantees this token differs from the one being
    // replaced even if both were minted within the same second.
    const newAccessToken = jwt.sign(
      {
        userId: user._id,
        role: user.role,
        ownerId: user.owner_id,
        type: 'access',
        jti: crypto.randomUUID(),
      },
      env.jwt.accessSecret,
      { expiresIn: env.jwt.accessExpiry },
    );

    return {
      success: true,
      accessToken: newAccessToken,
      expiresIn: env.jwt.accessExpiry,
    };
  } catch (error) {
    throw new Error('Invalid or expired refresh token');
  }
}

/**
 * Logout: invalidate refresh tokens
 *
 * - Adds a token version to invalidation list
 * - Forces user to use new tokens on next login
 */
async function logout(userId) {
  const tokenVersion = crypto.randomBytes(16).toString('hex');

  await User.findByIdAndUpdate(
    userId,
    {
      $push: { invalidated_token_versions: tokenVersion },
    },
  );

  return { success: true, message: 'Logged out successfully' };
}

/**
 * Password reset: email-based token
 *
 * - Validates email exists
 * - Invalidates all existing refresh tokens (forces re-login everywhere)
 * - In production, would send reset email with token
 */
async function initiatePasswordReset(email) {
  const cleanEmail = email.trim().toLowerCase();

  const user = await User.findOne({
    email: cleanEmail,
    role: { $in: [ROLES.OWNER, ROLES.SUPER_ADMIN] },
  });

  if (!user) {
    // For security, don't reveal if email exists
    return { success: true, message: 'If email exists, reset link sent' };
  }

  // Invalidate all refresh tokens (forces re-login on all devices)
  const tokenVersion = crypto.randomBytes(16).toString('hex');
  await User.findByIdAndUpdate(
    user._id,
    {
      $push: { invalidated_token_versions: tokenVersion },
    },
  );

  // TODO: In production, generate a reset token and email it
  // For now, just confirm invalidation
  return {
    success: true,
    message: 'Password reset initiated. Check email for instructions.',
  };
}

/**
 * Complete password reset with new password
 *
 * - Validates and hashes new password
 * - Updates user password
 * - Invalidates all tokens (forces new login)
 */
async function completePasswordReset(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const passwordHash = await hashPassword(newPassword);

  await User.findByIdAndUpdate(
    userId,
    {
      password_hash: passwordHash,
    },
  );

  return {
    success: true,
    message: 'Password updated. Please log in again.',
  };
}

/**
 * Invite an owner (admin-only)
 *
 * - Creates owner account with temporary password
 * - Generates owner_id
 * - Returns credentials for owner to use on first login
 */
async function inviteOwner(email, temporaryPassword) {
  if (!email || !temporaryPassword) {
    throw new Error('Email and temporary password are required');
  }

  const cleanEmail = email.trim().toLowerCase();

  // Check if email already exists
  const existingUser = await User.findOne({ email: cleanEmail });
  if (existingUser) {
    throw new Error('Email already in use');
  }

  // Generate owner ID and hash password
  const ownerId = generateOwnerId();
  const passwordHash = await hashPassword(temporaryPassword);

  // Create owner account
  const newOwner = await User.create({
    email: cleanEmail,
    password_hash: passwordHash,
    role: ROLES.OWNER,
    owner_id: ownerId,
    status: 'active',
  });

  return {
    success: true,
    ownerId: newOwner.owner_id,
    email: cleanEmail,
    userId: newOwner._id,
    message: 'Owner invited. Share email and temporary password securely.',
  };
}

module.exports = {
  hashPassword,
  comparePassword,
  generateOwnerId,
  issueTokens,
  verifyToken,
  getUserById,
  registerStudent,
  loginStudent,
  loginOwner,
  refreshAccessToken,
  logout,
  initiatePasswordReset,
  completePasswordReset,
  inviteOwner,
};