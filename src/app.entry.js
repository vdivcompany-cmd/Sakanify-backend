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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// --- 404 fallback for unknown routes ---
app.use((req, res) => {
  return res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// --- Central error handler (must be mounted last) ---
app.use(errorHandler);

module.exports = app;
