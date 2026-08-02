/**
 * app.entry.js
 *
 * Boots the Express app: mounts shared middlewares and the health-check
 * route, and stays ready for future module routers to be mounted as they
 * are built (Phase 1 onward). No business logic lives here — assembly
 * and boot only, per the Phase 0 spec.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const env = require('./config/env.config');
const database = require('./config/database.config');
const storage = require('./config/storage.config');
const requestLogger = require('./middleware/request-logger.middleware');
const rateLimiter = require('./middleware/rate-limiter.middleware');
const errorHandler = require('./middleware/error-handler.middleware');
const { success } = require('./shared/utils/response.util');

const app = express();

// --- Core middlewares ---
app.use(helmet());

// Security-hardening-pass addition (Aug 2026, hardening-audit Category 6):
// `cors()` with no options reflects/allows every origin (equivalent to a
// wildcard `*`), which is not safe for endpoints that return
// authenticated, owner/student-scoped data. Origins are now driven by
// env.cors.allowedOrigins (ALLOWED_ORIGINS env var), defaulting to an
// empty allowlist — no browser origin is trusted until the real frontend's
// domain is explicitly added. Non-browser clients (curl, mobile apps,
// server-to-server, and the test suite's supertest requests) don't send an
// Origin header at all, so `!origin` is allowed through here — this option
// only ever gates browser-originated cross-origin requests, which is the
// only thing CORS can control in the first place.
app.use(cors({
  origin(origin, callback) {
    if (!origin || env.cors.allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin "${origin}" is not allowed by CORS policy`));
  },
  credentials: true,
}));

// Security-hardening-pass addition (hardening-audit Category "Unrestricted
// Resource Consumption" / threat-catalog Category D): explicit body-size
// caps rather than relying on express.json()'s implicit 100kb default —
// this project's JSON payloads (bed/building/rental/payment fields) are all
// small; actual file uploads (KYC photos) go through multer's own
// memory-buffered 5MB limit (file-upload.util.js), never through this
// JSON/urlencoded parser.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(requestLogger);
app.use(rateLimiter);

// --- Health check: verifies server, DB, and storage connections ---
app.get('/health', async (req, res) => {
  const dbConnected = database.isConnected();
  const storageStatus = await storage.checkConnection();

  const healthy = dbConnected; // storage is optional/not-yet-provisioned, doesn't gate health

  return success(res, {
    statusCode: healthy ? 200 : 503,
    message: healthy ? 'OK' : 'Degraded',
    data: {
      server: 'up',
      env: env.nodeEnv,
      database: {
        connected: dbConnected,
      },
      storage: storageStatus,
      timestamp: new Date().toISOString(),
    },
  });
});

// --- Module routers are mounted here ---
// Phase 1: Authentication
app.use('/api/auth', require('./modules/auth/auth.routes'));

// Phase 2: Students & Simplified KYC
app.use('/api/students', require('./modules/students/student.routes'));
app.use('/api/kyc', require('./modules/kyc/kyc.routes'));

// Phase 3: Buildings, Apartments, Beds, and the central Audit module
app.use('/api/buildings', require('./modules/buildings/building.routes'));
app.use('/api/apartments', require('./modules/apartments/apartment.routes'));
app.use('/api/beds', require('./modules/beds/bed.routes'));
app.use('/api/audit', require('./modules/audit/audit.routes'));

// Phase 4: Booking Engine (Requests & Rentals)
app.use('/api/requests', require('./modules/requests/request.routes'));
app.use('/api/rentals', require('./modules/rentals/rental.routes'));

// Phase 5: Cash Payment Tracking (recurring monthly billing)
app.use('/api/payments', require('./modules/payments/payment.routes'));

// Phase 6: Owner Subscriptions & Bed Capacity + Optional Utility Bill Splitting
app.use('/api/subscriptions', require('./modules/subscriptions/subscription.routes'));
app.use('/api/utilities', require('./modules/utilities/utility-bill.routes'));

// Phase 7: Super-Admin / V Div Control Center
app.use('/api/admin', require('./modules/admin/admin.routes'));

// Phase 8: Public Site API — the first fully unauthenticated route
// surface (subscribed-buildings directory, transparency counters, public
// lead capture), plus a small authenticated owner-facing slice
// (list/view their own public leads). Every route in this router applies
// its own IP-keyed rate limiting on top of this file's global rateLimiter
// above — see public.routes.js.
app.use('/api/public', require('./modules/public-site/public.routes'));

// --- 404 fallback for unknown routes ---
app.use((req, res) => {
  return res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// --- Central error handler (must be mounted last) ---
app.use(errorHandler);

module.exports = app;
