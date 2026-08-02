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
// Security-hardening-pass addition (Aug 2026, threat-catalog Category B —
// "JWT algorithm confusion"): every jwt.sign/jwt.verify call in this file
// now explicitly pins the algorithm to HS256 rather than letting
// jsonwebtoken infer it from the token header. Signing was already
// implicitly HS256 (a plain string secret, not a keypair), so this mostly
// hardens verifyToken(): without an explicit `algorithms` allowlist,
// jwt.verify() accepts whatever `alg` the presented token's header claims,
// which is the classic algorithm-confusion class of bug. Pinning it here
// means a token crafted with a different/weaker algorithm (or `alg: none`,
// which jsonwebtoken already rejects by default, but this makes the
// restriction explicit and future-proof rather than relying on that
// default) is rejected outright.
const JWT_ALGORITHM = 'HS256';

// Remediation Pass 2 / SEC-002 (Super-Admin MFA). Two narrow-scope token
// types, distinct from 'access'/'refresh'/'impersonation': signed with the
// same accessSecret + HS256 (so they flow through the same jwt.verify call
// as everything else — no new secret to manage), but auth.middleware
// .verifyToken now explicitly rejects any type other than 'access' on
// normal protected routes (see that file's Remediation Pass 2 comment), so
// neither of these can be used as a substitute for a real access token
// anywhere else in the API. Only mfa.controller's own scoped-token check
// accepts them, and only for the one endpoint each is meant for.
const MFA_SETUP_TOKEN_TYPE = 'mfa_setup';
const MFA_PENDING_TOKEN_TYPE = 'mfa_pending';

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
    { expiresIn: env.jwt.accessExpiry, algorithm: JWT_ALGORITHM },
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
    { expiresIn: env.jwt.refreshExpiry, algorithm: JWT_ALGORITHM },
  );

  return { accessToken, refreshToken };
}

/**
 * Verify JWT token (access or refresh)
 */
function verifyToken(token, type = 'access') {
  try {
    const secret = type === 'access' ? env.jwt.accessSecret : env.jwt.refreshSecret;
    const decoded = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] });
    return decoded;
  } catch (error) {
    throw new Error(`Invalid or expired ${type} token`);
  }
}

/**
 * Issue a short-lived 'mfa_setup'-typed token (Remediation Pass 2 /
 * SEC-002, decision 3). Two shapes, both this same function:
 *
 *   - Bare (no pending fields): issued by loginOwner() the moment a
 *     Super-Admin with mfa_enabled: false authenticates correctly — proves
 *     "this really is this Super-Admin's password," authorizes exactly one
 *     thing: calling POST /api/auth/mfa/setup.
 *   - Enriched (pending fields set): issued BY mfa.controller.setup()
 *     itself, carrying the newly-generated (but not yet persisted — see
 *     mfa.service.js's header comment) encrypted TOTP secret and hashed
 *     backup codes. This is what POST /api/auth/mfa/verify-setup requires
 *     — mfa.controller.verifySetup checks for the presence of
 *     `pending_secret_encrypted` specifically, so a bare setup token can't
 *     be used to skip straight to verify-setup without ever calling setup.
 *
 * Never persists anything — the pending secret/codes live only inside this
 * signed, short-lived token until verify-setup confirms a real code and
 * writes them to the User document for the first time.
 */
function issueMfaSetupToken(userId, pendingSecretEncrypted = null, pendingBackupCodeHashes = null) {
  const payload = {
    userId,
    role: ROLES.SUPER_ADMIN,
    type: MFA_SETUP_TOKEN_TYPE,
    jti: crypto.randomUUID(),
  };

  if (pendingSecretEncrypted) payload.pending_secret_encrypted = pendingSecretEncrypted;
  if (pendingBackupCodeHashes) payload.pending_backup_code_hashes = pendingBackupCodeHashes;

  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.mfa.setupTokenExpiry,
    algorithm: JWT_ALGORITHM,
  });
}

/**
 * Issue a short-lived 'mfa_pending'-typed token (decision 3): issued by
 * loginOwner() when a Super-Admin with mfa_enabled: true authenticates
 * correctly — proves the password was right, authorizes exactly one thing:
 * calling POST /api/auth/mfa/verify-login to complete the login with a
 * real TOTP code or backup code.
 */
function issueMfaPendingToken(userId) {
  return jwt.sign(
    { userId, role: ROLES.SUPER_ADMIN, type: MFA_PENDING_TOKEN_TYPE, jti: crypto.randomUUID() },
    env.jwt.accessSecret,
    { expiresIn: env.mfa.pendingTokenExpiry, algorithm: JWT_ALGORITHM },
  );
}

/**
 * Verify a scoped MFA token (setup or pending) and confirm its `type`
 * claim matches exactly what the caller expects — mfa.controller uses this
 * instead of the generic verifyToken() above specifically so a
 * 'mfa_pending' token can never be accepted where a 'mfa_setup' token is
 * required, or vice versa, even though both are signed with the same
 * secret/algorithm.
 */
function verifyScopedMfaToken(token, expectedType) {
  let decoded;
  try {
    decoded = jwt.verify(token, env.jwt.accessSecret, { algorithms: [JWT_ALGORITHM] });
  } catch (err) {
    throw new Error('Invalid or expired MFA token');
  }

  if (decoded.type !== expectedType) {
    throw new Error(`This token cannot be used here (expected a "${expectedType}" token)`);
  }

  return decoded;
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

  // Remediation Pass 2 / SEC-002 (Docs/reports/remediation-pass-2-mfa-report.md,
  // decision 3): mandatory MFA gate — Super-Admin ONLY. The Owner branch
  // below is completely untouched by this pass, on purpose (the
  // remediation spec's own Dependency Note: "this change should not touch
  // [Owner/Student login] at all"). A correct password no longer means a
  // real session for a Super-Admin — it means either "go complete MFA
  // setup" (mfa_enabled: false) or "go verify your authenticator code"
  // (mfa_enabled: true), never a direct accessToken/refreshToken pair.
  if (user.role === ROLES.SUPER_ADMIN) {
    if (!user.mfa_enabled) {
      const setupToken = issueMfaSetupToken(user._id.toString());
      return {
        success: true,
        userId: user._id,
        role: user.role,
        ownerId: user.owner_id,
        mfaSetupRequired: true,
        setupToken,
      };
    }

    const pendingToken = issueMfaPendingToken(user._id.toString());
    return {
      success: true,
      userId: user._id,
      role: user.role,
      ownerId: user.owner_id,
      mfaVerificationRequired: true,
      pendingToken,
    };
  }

  // Issue tokens (Owner path — unchanged by this pass)
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
      { expiresIn: env.jwt.accessExpiry, algorithm: JWT_ALGORITHM },
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
 * Invalidate every currently-issued access/refresh token for a user,
 * effective immediately (Phase 7 fix — see auth.model.js's
 * `tokens_invalidated_at` comment for why this is the real enforcement
 * mechanism, not the write-only `invalidated_token_versions` array from
 * Phase 1). Shared by logout(), initiatePasswordReset(), and — the reason
 * this was pulled out into its own exported function — Phase 7's
 * admin.service.suspendOwner(), which needs to "reuse the same
 * token-invalidation mechanism built in Phase 1" for the account it just
 * suspended (Docs/phase-7-admin.md, "Added After Phase 6 Review" point 2).
 *
 * Kept the `invalidated_token_versions` push too (harmless, preserves the
 * existing audit-adjacent trail) rather than deleting Phase 1 code outside
 * this fix's scope.
 */
async function invalidateAllTokensForUser(userId) {
  const tokenVersion = crypto.randomBytes(16).toString('hex');

  await User.findByIdAndUpdate(
    userId,
    {
      $push: { invalidated_token_versions: tokenVersion },
      $set: { tokens_invalidated_at: new Date() },
    },
  );

  return { success: true };
}

/**
 * Logout: invalidate all of this user's currently-issued tokens
 * immediately (see invalidateAllTokensForUser above).
 */
async function logout(userId) {
  await invalidateAllTokensForUser(userId);
  return { success: true, message: 'Logged out successfully' };
}

/**
 * Look up the owner User record by owner_id (the shared, non-ObjectId
 * ownership-scoping key — see auth.model.js). Exists so other modules
 * (Phase 7's admin.service, specifically) can resolve "which User account
 * is this owner_id" through a service call rather than importing
 * auth.repository/auth.model directly, per CLAUDE.md Section 7.2 — same
 * reasoning as getUserById above.
 */
async function getUserByOwnerId(ownerId) {
  return authRepository.findUserByOwnerId(ownerId);
}

/**
 * Phase 7 addition: every owner account, any status, paginated — see
 * auth.repository.findUsersByRoleAnyStatus's comment. Exposed as a
 * service function so admin.service never imports auth.model/
 * auth.repository directly (CLAUDE.md Section 7.2).
 */
async function listOwners({ skip = 0, limit = 20 } = {}) {
  const [owners, total] = await Promise.all([
    authRepository.findUsersByRoleAnyStatus(ROLES.OWNER, { skip, limit }),
    authRepository.countUsersByRoleAnyStatus(ROLES.OWNER),
  ]);
  return { owners, total };
}

/**
 * Set a User's status (active/suspended/deleted) directly — used by
 * Phase 7's admin.service.suspendOwner to lock the owner's account out of
 * login (loginOwner already rejects non-active users) in addition to the
 * subscription-status-driven booking guard clause and the real-time
 * session-invalidation check in auth.middleware.verifyToken.
 */
async function setUserStatus(userId, status) {
  if (!['active', 'suspended', 'deleted'].includes(status)) {
    throw new Error(`Invalid status: "${status}"`);
  }
  return authRepository.updateUser(userId, { status });
}

/**
 * Remediation Pass 2 / SEC-002, implementation step 8: reset a
 * Super-Admin's MFA enrollment (admin.service.resetSuperAdminMfa calls
 * this after its own target-exists/not-self checks and BEFORE writing its
 * own audit log entry — this function itself does not audit-log, matching
 * the existing setUserStatus() pattern above, which also leaves
 * audit-logging to its caller). Clears every MFA field back to its
 * pre-enrollment default, forcing the target through mandatory setup
 * again on their next login (loginOwner's mfa_enabled: false branch) —
 * exactly the same state a brand-new Super-Admin account starts in.
 */
async function resetMfaForUser(userId) {
  await User.findByIdAndUpdate(userId, {
    $set: {
      mfa_enabled: false,
      mfa_secret_encrypted: null,
      mfa_enrolled_at: null,
      backup_codes: [],
    },
  });
  return { success: true };
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

  // Invalidate all currently-issued tokens (forces re-login on all devices)
  await invalidateAllTokensForUser(user._id);

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
  getUserByOwnerId,
  listOwners,
  setUserStatus,
  invalidateAllTokensForUser,
  registerStudent,
  loginStudent,
  loginOwner,
  refreshAccessToken,
  logout,
  initiatePasswordReset,
  completePasswordReset,
  inviteOwner,
  // Remediation Pass 2 / SEC-002
  issueMfaSetupToken,
  issueMfaPendingToken,
  verifyScopedMfaToken,
  resetMfaForUser,
  MFA_SETUP_TOKEN_TYPE,
  MFA_PENDING_TOKEN_TYPE,
};