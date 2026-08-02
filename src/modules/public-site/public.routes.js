/**
 * public.routes.js
 *
 * The first fully unauthenticated route surface in the backend
 * (Docs/phase-8-public-site.md: "Every endpoint here is reachable with
 * no login and no rate-limit-by-account"). Every route below gets its
 * own IP-keyed rate limiter, on top of app.entry.js's global limiter —
 * implementation step 7.
 *
 * Two limiters, same reasoning + MemoryStore-for-tests pattern as
 * auth.routes.js's otp/login/passwordReset limiters (see that file's
 * comment for why each limiter gets its own explicit MemoryStore rather
 * than an implicit default one — purely so tests can resetAll() between
 * suites without one test's requests exhausting every later test's
 * quota):
 *   - browsingLimiter: generous — read-only listing/detail/counter
 *     endpoints.
 *   - leadLimiter: much stricter — POST /leads is the one endpoint here
 *     that writes data, and per the phase spec is "the more attractive
 *     abuse target" (a script spamming fake leads against real beds).
 *
 * The owner-facing "my public leads" routes at the bottom are
 * authenticated (verifyToken + requireRole(OWNER)) and are NOT
 * IP-limited here — they're already covered by the global limiter in
 * app.entry.js, same as every other authenticated route in the backend.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createRateLimitStore } = require('../../shared/utils/redis-rate-limit-store');
const publicController = require('./public.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

// Remediation Pass 3 / SEC-004: same shared, Redis-backed (or
// automatically in-memory-fallback) store factory as every other limiter
// in the backend — see redis-rate-limit-store.js's header comment.
const browsingStore = createRateLimitStore('public-browse:');
const leadStore = createRateLimitStore('public-lead:');

// Browsing (listing/detail/counters): generous — this traffic is
// expected to be the bulk of this module's load and has no write
// side-effect to abuse.
const browsingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120,
  message: 'Too many requests. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: browsingStore,
});

// Lead submission: strict — the one write endpoint on this
// unauthenticated surface, and the one CLAUDE.md/the phase spec singles
// out as the more attractive abuse target.
const leadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: 'Too many submissions from this connection. Please try again later.',
  standardHeaders: false,
  legacyHeaders: false,
  store: leadStore,
});

// --- Public, unauthenticated endpoints ---
router.get('/buildings', browsingLimiter, publicController.listBuildings);
router.get('/buildings/:buildingId', browsingLimiter, publicController.getBuildingDetail);
router.get('/counters', browsingLimiter, publicController.getTransparencyCounters);
router.post('/leads', leadLimiter, publicController.submitLead);

// --- Owner-facing, authenticated: their own public leads ---
router.get('/leads/mine', verifyToken, requireRole(ROLES.OWNER), publicController.listMyLeads);
router.get('/leads/mine/:leadId', verifyToken, requireRole(ROLES.OWNER), publicController.getMyLead);

// --- Test-only escape hatch, same pattern as auth.routes.js ---
// Exposes the rate-limit stores so integration tests can call
// resetAll() between test suites/cases (see tests/integration/*.test.js).
router.rateLimitStores = {
  browsing: browsingStore,
  lead: leadStore,
};

module.exports = router;
