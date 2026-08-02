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
 * Ownership scoping middleware for route handlers
 *
 * Validates that req.user.ownerId matches req.params.ownerId or req.body.owner_id
 *
 * Usage:
 *   router.post('/buildings/:ownerId', verifyToken, ownershipScopingMiddleware, controller);
 */
function ownershipScopingMiddleware(req, res, next) {
  if (!req.user) {
    return error(res, {
      statusCode: 401,
      message: 'Authentication required',
    });
  }

  // Super-admins bypass ownership scoping
  if (req.user.role === 'super-admin') {
    return next();
  }

  // For owners, validate they're accessing their own data
  if (req.user.role === 'owner') {
    const requestedOwnerId = req.params.ownerId || req.body.owner_id;

    if (!requestedOwnerId) {
      return error(res, {
        statusCode: 400,
        message: 'Missing owner_id in request',
      });
    }

    if (req.user.ownerId !== requestedOwnerId) {
      return error(res, {
        statusCode: 403,
        message: 'Access denied: you can only access your own data',
      });
    }
  }

  next();
}

module.exports = {
  verifyToken,
  requireRole,
  requireOwner,
  ownershipScoping,
  ownershipScopingMiddleware,
};