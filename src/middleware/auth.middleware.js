/**
 * auth.middleware.js
 *
 * Authentication and authorization middleware used by every module:
 * - verifyToken: Extract and validate JWT from Authorization header
 * - requireRole: Restrict endpoint to specific role(s)
 * - requireOwner: Restrict to authenticated owner (verified by ownership_scoping)
 * - ownershipScoping: Validate that requested resource belongs to authenticated owner
 *
 * These middlewares enforce the security guarantees documented in CLAUDE.md:
 * - Role isolation (student != owner != super-admin)
 * - Ownership scoping (owner A cannot access owner B's data)
 * - Super-admin-only routes for sensitive operations
 */

const { error } = require('../shared/utils/response.util');
const authService = require('../modules/auth/auth.service');
const authRepository = require('../modules/auth/auth.repository');
const adminRepository = require('../modules/admin/admin.repository');

/**
 * Verify JWT access token and attach user info to req.user
 *
 * Expected header: Authorization: Bearer <token>
 * Sets req.user = { userId, role, ownerId }
 *
 * Phase 7 addition: after the JWT signature/expiry check passes, this now
 * also does a real-time DB check so account suspension and logout/
 * password-reset actually take effect immediately, not just at the
 * token's natural ~15-30 minute expiry:
 *   1. The user must still exist and have status === 'active'.
 *   2. The token's `iat` (issued-at) must be AFTER the user's
 *      `tokens_invalidated_at` cutoff, if one is set.
 * See auth.model.js's `tokens_invalidated_at` comment for why this check
 * didn't exist before Phase 7 and why it was necessary to add it — a
 * suspend/logout that only ever looked like it worked (cosmetic) is
 * exactly the failure mode CLAUDE.md and this phase's spec call out.
 *
 * Impersonation tokens (Phase 7, admin.service.impersonateOwner) are a
 * distinct `type: 'impersonation'` token, handled separately below: they
 * are checked against the ImpersonationSession record (by jti) rather than
 * the target owner's own status/invalidation cutoff, since a super-admin
 * may deliberately need to impersonate a suspended owner for support
 * purposes — see admin.service.js's doc comment on this decision.
 */
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, {
        statusCode: 401,
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix

    let decoded;
    try {
      decoded = authService.verifyToken(token, 'access');
    } catch (jwtError) {
      return error(res, {
        statusCode: 401,
        message: 'Invalid or expired access token',
      });
    }

    try {
      if (decoded.type === 'impersonation') {
        const session = await adminRepository.findActiveByJti(decoded.jti);
        if (!session) {
          return error(res, {
            statusCode: 401,
            message: 'Impersonation session has ended or is invalid',
          });
        }

        const admin = await authRepository.findUserById(decoded.impersonating_admin_id);
        if (!admin || admin.status !== 'active') {
          return error(res, {
            statusCode: 401,
            message: 'Impersonating admin account is no longer active',
          });
        }

        req.user = {
          userId: decoded.userId,
          role: decoded.role,
          ownerId: decoded.ownerId,
          impersonation: {
            adminId: decoded.impersonating_admin_id,
            jti: decoded.jti,
          },
        };
        return next();
      }

      // Remediation Pass 2 / SEC-002 hardening: reject any token whose
      // `type` claim isn't 'access' here. Before this pass, only
      // 'impersonation' was special-cased above — anything else (including
      // a 'refresh' token, or the new 'mfa_setup'/'mfa_pending' scoped
      // tokens this pass introduces) fell through to this normal path and
      // would have been accepted as a full session token purely because it
      // was signed with the same accessSecret and carried a valid
      // userId/role. That was previously harmless only by accident: no
      // other token type was ever signed with accessSecret before this
      // pass (refresh tokens use a separate refreshSecret). Now that
      // mfa_setup/mfa_pending tokens exist and ARE signed with
      // accessSecret (so they reuse this same jwt.verify call), this check
      // is load-bearing — without it, a narrowly-scoped MFA token could be
      // used to reach any protected endpoint in the API, not just the
      // /mfa/* routes it was actually issued for.
      if (decoded.type !== 'access') {
        return error(res, {
          statusCode: 401,
          message: 'This token cannot be used to access this endpoint',
        });
      }

      const user = await authRepository.findUserById(decoded.userId);
      if (!user || user.status !== 'active') {
        return error(res, {
          statusCode: 401,
          message: 'Account is not active',
        });
      }

      if (user.tokens_invalidated_at && decoded.iat * 1000 <= user.tokens_invalidated_at.getTime()) {
        return error(res, {
          statusCode: 401,
          message: 'Token has been invalidated — please log in again',
        });
      }

      // Attach user info to request
      req.user = {
        userId: decoded.userId,
        role: decoded.role,
        ownerId: decoded.ownerId, // Can be null for students/super-admins
      };

      return next();
    } catch (dbError) {
      console.error('[auth.middleware:verifyToken] session-validity check failed', dbError);
      return error(res, {
        statusCode: 500,
        message: 'Authentication error',
      });
    }
  } catch (err) {
    return error(res, {
      statusCode: 500,
      message: 'Authentication error',
    });
  }
}

/**
 * Require a specific role or list of roles
 *
 * Usage:
 *   router.post('/admin', requireRole(ROLES.SUPER_ADMIN), controller);
 *   router.get('/data', requireRole([ROLES.STUDENT, ROLES.OWNER]), controller);
 */
function requireRole(allowedRoles) {
  // Normalize to array
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    if (!req.user) {
      return error(res, {
        statusCode: 401,
        message: 'Authentication required',
      });
    }

    if (!rolesArray.includes(req.user.role)) {
      return error(res, {
        statusCode: 403,
        message: 'Access denied: insufficient permissions',
      });
    }

    next();
  };
}

/**
 * Require authenticated owner (non-student with owner_id)
 *
 * Used to verify the current request is from an owner, not a student or super-admin.
 * Does NOT validate ownership scoping — that's done by ownershipScoping().
 */
function requireOwner(req, res, next) {
  if (!req.user || !req.user.ownerId) {
    return error(res, {
      statusCode: 403,
      message: 'Owner access required',
    });
  }

  next();
}

/**
 * Ownership scoping helper: validate that a resource belongs to the authenticated owner
 *
 * Used to ensure Owner A cannot read/write Owner B's data.
 * Call this to validate a requested resource_owner_id matches req.user.ownerId.
 *
 * Usage (in a controller):
 *   const building = await buildingService.getBuilding(buildingId);
 *   ownershipScoping(req.user.ownerId, building.owner_id);
 *
 * Returns nothing if scoping check passes.
 * Throws error if scoping check fails (catch and return error response).
 */
function ownershipScoping(authenticatedOwnerId, resourceOwnerId) {
  if (!authenticatedOwnerId || !resourceOwnerId) {
    throw new Error('Ownership scoping: authenticated user or resource is not owner-scoped');
  }

  if (authenticatedOwnerId !== resourceOwnerId) {
    throw new Error('Access denied: you do not have permission to access this resource');
  }
}

/**
 * Remediation Pass 2 / SEC-002: authorizes POST /api/auth/mfa/setup.
 * Accepts exactly two token shapes (decision 3: "callable only with a
 * valid 'setup token' ... or by an already-fully-authenticated
 * Super-Admin re-generating their setup"), both signed with accessSecret
 * so a single jwt.verify call (via authService.verifyToken(token,
 * 'access'), which only checks signature/algorithm — NOT the `type`
 * claim) covers both:
 *
 *   - type: 'access', role: SUPER_ADMIN — a real, currently-valid full
 *     session. Same liveness checks as the normal verifyToken() above
 *     (account active, not invalidated since issue) apply, since this IS
 *     a real session token being reused for a second purpose.
 *   - type: 'mfa_setup', role: SUPER_ADMIN — the narrow token
 *     authService.loginOwner() issues when mfa_enabled is false. No
 *     tokens_invalidated_at check: this is a one-shot action token, not a
 *     session, so that mechanism doesn't apply to it.
 *
 * Any other type (including 'mfa_pending' or 'refresh') is rejected here,
 * same reasoning as the hardening in verifyToken() above.
 */
async function verifyMfaSetupAccess(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, { statusCode: 401, message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    let decoded;
    try {
      decoded = authService.verifyToken(token, 'access');
    } catch (jwtError) {
      return error(res, { statusCode: 401, message: 'Invalid or expired token' });
    }

    if (decoded.role !== 'super-admin' || (decoded.type !== 'access' && decoded.type !== 'mfa_setup')) {
      return error(res, { statusCode: 401, message: 'This token cannot be used to access MFA setup' });
    }

    const user = await authRepository.findUserById(decoded.userId);
    if (!user || user.status !== 'active') {
      return error(res, { statusCode: 401, message: 'Account is not active' });
    }

    if (
      decoded.type === 'access'
      && user.tokens_invalidated_at
      && decoded.iat * 1000 <= user.tokens_invalidated_at.getTime()
    ) {
      return error(res, { statusCode: 401, message: 'Token has been invalidated — please log in again' });
    }

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      tokenType: decoded.type,
      pendingSecretEncrypted: decoded.pending_secret_encrypted || null,
      pendingBackupCodeHashes: decoded.pending_backup_code_hashes || null,
    };
    return next();
  } catch (err) {
    return error(res, { statusCode: 500, message: 'Authentication error' });
  }
}

/**
 * Remediation Pass 2 / SEC-002: authorizes POST /api/auth/mfa/verify-login.
 * Strictly requires a 'mfa_pending' token — the one
 * authService.loginOwner() issues when a Super-Admin with mfa_enabled:
 * true authenticates correctly. Deliberately does NOT accept a full
 * 'access' token: there is no legitimate reason to "verify login" for a
 * session that already exists.
 */
async function verifyMfaPendingAccess(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, { statusCode: 401, message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    let decoded;
    try {
      decoded = authService.verifyScopedMfaToken(token, authService.MFA_PENDING_TOKEN_TYPE);
    } catch (jwtError) {
      return error(res, { statusCode: 401, message: 'Invalid or expired MFA session — please log in again' });
    }

    const user = await authRepository.findUserById(decoded.userId);
    if (!user || user.status !== 'active') {
      return error(res, { statusCode: 401, message: 'Account is not active' });
    }

    req.user = { userId: decoded.userId, role: decoded.role };
    return next();
  } catch (err) {
    return error(res, { statusCode: 500, message: 'Authentication error' });
  }
}

// Remediation Pass 1 / SEC-005 (Docs/reports/remediation-pass-1-report.md):
// an `ownershipScopingMiddleware` function used to live here — a
// route-level middleware that trusted `req.params.ownerId`/
// `req.body.owner_id` (client-supplied) directly, rather than a value
// read back from the database. It was confirmed dead code (re-grepped
// project-wide before removal, same as the audit's own check: zero
// references anywhere outside this file) and was never the pattern
// actually used by any live route — every real ownership check in this
// codebase instead fetches the resource first, then calls
// ownershipScoping(req.user.ownerId, resource.owner_id) below, which is
// the structurally safer of the two patterns. Removed entirely rather
// than left in place/commented-out, so it can't be reached for by a
// future route without noticing it was the weaker option.

module.exports = {
  verifyToken,
  requireRole,
  requireOwner,
  ownershipScoping,
  verifyMfaSetupAccess,
  verifyMfaPendingAccess,
};