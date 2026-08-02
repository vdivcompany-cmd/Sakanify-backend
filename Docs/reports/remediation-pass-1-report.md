# Remediation Pass 1 — Report

Based on `Docs/reports/ENTERPRISE_BACKEND_AUDIT_REPORT.md` and the fix-authorized scope in `remediation-pass-1.md`.

**Language note:** written in English, matching both source documents (`ENTERPRISE_BACKEND_AUDIT_REPORT.md` and `remediation-pass-1.md`), for the same reason stated in the audit report — this is a technical engineering deliverable with an explicit English structure, not a numbered phase's stakeholder-facing report under `CLAUDE.md` Section 1.

**Date:** 2026-08-02

**Status: fully verified via real GitHub Actions — see "Real CI Confirmation" section near the end of this report.**

## Scope (as authorized)

Fixed in this pass: **SEC-001** (critical), **DB-001** (medium), **SEC-005** (low), **SEC-006** (informational).

Explicitly NOT touched, per `remediation-pass-1.md`'s own Scope Decision — confirmed untouched in this pass: **SEC-002** (Super-Admin MFA — no login-flow files were modified), **SEC-004** (Redis-backed rate limiter — `rate-limiter.middleware.js` and the OTP/login/password-reset/lead/browsing limiters all still use `MemoryStore`, unchanged), **SEC-003** (`langchain`/`node-cron` dependency versions — `package.json`/`package-lock.json` were not modified), and infrastructure items (Atlas IP allowlist, backup-restore drill, TLS) — none of these are code, none were in scope.

---

## Fix 1 — SEC-001: OTP Code Removed From API Response (Critical)

**Files changed:**
- `src/modules/auth/otp.service.js`
- `tests/integration/auth.test.js`
- `tests/integration/auth-real.test.js`
- `tests/integration/students-kyc.test.js`
- `scripts/test-auth-direct.js`, `scripts/test-e2e-final.js`, `scripts/test-e2e-scenarios.js` (not part of the Jest suite or CI — standalone manual dev scripts not referenced by `package.json` or `.github/workflows/backend-tests.yml` — but they also read `_dev_code` and would have silently broken; fixed for consistency since the effort was trivial)

**What changed:**

1. `otp.service.requestOtp()` no longer includes the OTP code in its returned object under any condition — the `_dev_code` field is gone entirely, not gated behind `NODE_ENV`. This was a deliberate design choice, matching the audit's own reasoning: an env-name check alone isn't a safe boundary, since a staging deployment could plausibly run with `NODE_ENV=development`. The fix is removal from the API response contract, full stop.
2. `auth.controller.requestOtp()` required no code change — it passes `otpService.requestOtp()`'s return value straight through as `data`, so once the code is gone from the service layer's return value, it's gone from the HTTP response automatically. Verified by reading the controller (unchanged) and by the new regression test below.
3. Added `otpService.__getLastOtpForPhone(phone)` — a test-only accessor that reads the most recently issued, still-`pending` OTP directly from the `OTP` collection (the same store the mock provider already writes to), never from an HTTP response. It's guarded by a new `IS_MOCK_PROVIDER` constant (currently `true`): if a real SMS provider is ever wired into `sendOtp()`, this accessor throws immediately instead of silently returning stale data, and the accompanying code comment says it should be deleted (along with every test call site) at that point.
4. `console.log`ging the raw OTP code in `sendOtp()` is now gated behind the same `IS_MOCK_PROVIDER` flag, for the same forward-looking reason — it won't silently keep logging real student OTPs to stdout once a real provider replaces the mock.
5. Updated every test that previously read `otpRes.body.data._dev_code` (3 Jest integration files, 4 standalone scripts) to call `otpService.__getLastOtpForPhone(phone)` instead. No shared test helper file existed in this codebase (each integration test file defines its own local `uniquePhone()`/login helpers) — confirmed by search before starting, so this was 3 files' worth of direct edits, not a single shared-helper change.
6. Added the explicit regression test the audit flagged as missing (Audit Section 14, item 2): `tests/integration/auth.test.js`, new test `'SEC-001: should never include the OTP code anywhere in the request-otp response body'`. It asserts against the actual secret value (fetched via `__getLastOtpForPhone`, never the HTTP response) with `expect(JSON.stringify(res.body)).not.toContain(actualCode)` — a stronger check than just asserting a specific field name is absent, since it would also catch the code leaking back out under some other field name in the future. The pre-existing test that asserted `_dev_code` **was** defined (the opposite of what we now want) was replaced rather than left alongside the new one.

**Verification performed:**
- `node --check` on all 7 changed files: all pass, zero syntax errors.
- Full module tree boot check (`require('./src/app.entry.js')` plus each changed module individually): loads cleanly, no circular-dependency or require-time error introduced.
- Project-wide `grep` for `_dev_code` across `src/`, `tests/`, `scripts/`: zero remaining live references — only the new negative-assertion test and explanatory code comments mention the string.
- Unit test suite (17 pre-existing + 3 new database-pool tests, see Fix 2) executed directly in this sandbox: **21/21 passing** (see the Verification section below for the full breakdown).
- The 3 integration files this fix touches (`auth.test.js`, `auth-real.test.js`, `students-kyc.test.js`) could **not** be executed in this sandbox — same `mongodb-memory-server`/`fastdl.mongodb.org` sandbox limitation documented in the audit report, re-confirmed still true today (see Verification section). Every call site was manually traced against the new `otp.service.js` API instead (confirmed `phone` is in scope at every replaced call site, confirmed the new accessor's DB query shape matches how `OTP.create()` actually stores records).

---

## Fix 2 — DB-001: Explicit MongoDB Connection Pool Configuration (Medium)

**Files changed:**
- `src/config/database.config.js`
- `tests/unit/database.config.pool.test.js` (new)

**What changed:**

1. `mongoose.connect(env.mongodbUri)` (zero options) is now `mongoose.connect(env.mongodbUri, CONNECTION_OPTIONS)`, where `CONNECTION_OPTIONS = { maxPoolSize: 50, minPoolSize: 5, serverSelectionTimeoutMS: 5000 }`.
2. Reasoning documented directly in a code comment above the constant (not just this report): values are sized for the current single-instance deployment (explicitly not yet revisited for the deferred SEC-004/multi-instance work); `serverSelectionTimeoutMS: 5000` specifically closes the audit's Reliability finding #4 (fail fast on an unreachable database instead of the driver's ~30s default), and matches the value `tests/integration/auth-real.test.js` already independently chose for its own direct `mongoose.connect()` call.
3. `CONNECTION_OPTIONS` is exported from the module (previously nothing was exported besides `connectDB`/`isConnected`/`connection`) specifically so the new test can assert against the real values in one place rather than duplicating/hardcoding them and risking silent drift between the code and the test.

**New unit test (`tests/unit/database.config.pool.test.js`, 3 tests, no database required — `mongoose.connect` is mocked):**
1. Confirms `CONNECTION_OPTIONS` has numeric `maxPoolSize`/`minPoolSize`/`serverSelectionTimeoutMS`, that the timeout is ≤10s (fail-fast), and that the pool bounds are sane relative to each other.
2. Confirms `connectDB()` actually passes `CONNECTION_OPTIONS` through to `mongoose.connect()`.
3. Confirms the retry path (on a simulated connection failure) still passes the same explicit options on the retry attempt, not a bare call — i.e. the fix applies to every connection attempt, not just the first.

**Verification performed:** executed directly in this sandbox — **3/3 passing** (real evidence, not a claim; full output in the Verification section).

---

## Fix 3 — SEC-005: Removed Unused, Weaker Ownership Middleware (Low)

**Files changed:**
- `src/middleware/auth.middleware.js`

**What changed:** Re-ran the project-wide `grep` for `ownershipScopingMiddleware` before touching anything, per the remediation instructions' own suggested caution — confirmed zero references anywhere outside its own definition/export in `auth.middleware.js` (same result as the audit's original check). Deleted the function and its export entirely (the preferred option per the remediation doc, over just commenting it deprecated) — replaced with a short code comment explaining why it existed, why it was weaker than the pattern actually in use (`ownershipScoping()`, fetch-resource-then-compare), and why it was removed rather than kept as a labeled trap.

**Verification performed:** `node --check` passes; re-grepped after the change to confirm the function name only appears in the explanatory comment now; full app boot check (Fix 1's verification) also exercises this file's `require()` path and loads cleanly, confirming `verifyToken`/`requireRole`/`requireOwner`/`ownershipScoping` (the four functions every live route actually depends on) are all still exported correctly.

---

## Fix 4 — SEC-006: Rate Limiter Added to Refresh-Token Endpoint (Informational)

**Files changed:**
- `src/modules/auth/auth.routes.js`

**What changed:** Added `refreshTokenLimiter` (30 requests / 15 minutes, its own `MemoryStore`, consistent with every other limiter in this file) and applied it to `POST /api/auth/refresh-token`, which previously had no rate limiter at all — the one auth endpoint that didn't, per the audit finding. The limit is deliberately generous (defense-in-depth, not anti-brute-force — refresh tokens are unguessable JWTs, not a brute-forceable secret, as the audit itself noted) and sized well above realistic legitimate usage (a client refreshing its access token roughly every 15-30 minutes per `env.jwt.accessExpiry` stays far under 30 requests/15 minutes even with unusually frequent refreshing). The store is also exposed via `router.rateLimitStores.refreshToken` for test `resetAll()` symmetry with the other three limiters, even though no existing test currently needs it (checked: at most 2-3 refresh-token calls total per test file, nowhere near the new limit).

**Verification performed:** `node --check` passes; confirmed via `grep` that only 2-3 calls to `/refresh-token` exist across the whole integration suite (well under the new limit of 30, so this change carries no regression risk to existing tests even though those tests couldn't be executed in this sandbox — see Verification section).

---

## Verification

### What was actually executed in this sandbox (real evidence)

| Suite | Result | Notes |
|---|---|---|
| `tests/unit/metadata-strip.util.test.js` | ✅ 8/8 passed | Unchanged by this pass; re-run as part of the full unit sweep |
| `tests/unit/error-handler.normalize.test.js` | ✅ 7/7 passed | Unchanged by this pass |
| `tests/unit/auth-jwt-algorithm.test.js` | ✅ 3/3 passed | Unchanged by this pass; also exercises `auth.service.js`, confirming Fix 1 didn't disturb it |
| `tests/unit/database.config.pool.test.js` | ✅ 3/3 passed | **New in this pass** (Fix 2) |
| **Unit total** | **✅ 21/21 passed** | Every unit test in the repository, executed directly, zero failures |
| `npm run` app-boot check (`require('./src/app.entry.js')` + each individually-changed module) | ✅ Loads cleanly | Confirms zero circular-dependency/require-time regression across all 4 fixes combined |
| Project-wide `grep` sweeps (`_dev_code`, `ownershipScopingMiddleware`) | ✅ Clean | No stray references to removed/changed API surfaces anywhere in `src/`/`tests/`/`scripts/` |
| `node --check` on every file in `tests/unit/`, `tests/integration/`, plus every touched `src/` file | ✅ All pass | Full syntax sweep, not just the files this pass edited |

### What could NOT be executed in this sandbox (honesty requirement, same as the audit report)

The full integration suite (`tests/integration/*.test.js`, 216 tests across 9 files, including the 3 files this pass modified) could not be run here. Re-confirmed today, not assumed from the audit: `curl https://fastdl.mongodb.org/` returned a connection failure (`000`) from this sandbox just now, while `curl https://registry.npmjs.org` returned `200` in the same session — the MongoDB binary CDN that `mongodb-memory-server` needs is still not reachable from this environment; general network access is fine. Attempting `tests/integration/auth.test.js` directly reproduced the same symptom as during the audit: the process hangs past a 40-second timeout with zero output, rather than failing fast.

**This means the specific instruction to "re-confirm the full pass/fail count across ALL suites" cannot be satisfied with a number from this sandbox** — doing so would mean fabricating a result, which this process does not do. What this report offers instead, as the closest honest substitute:

1. Every one of the 216 integration tests' source files passes `node --check` (no syntax regression anywhere, not just in the 3 touched files).
2. The full application module tree (`app.entry.js`, which transitively requires every route/controller/service/model in the project, including all 9 modules' routers) loads with zero errors — this is the same "does the whole thing at least boot" check the security-hardening report relied on for the same reason, and it is a meaningfully stronger signal than checking the 3 changed files in isolation, since a real circular-dependency or missing-export regression from this pass would surface here regardless of which file introduced it.
3. Every call site that changed as part of Fix 1 was manually re-read against the new `otp.service.js` API after editing, confirming `phone` (the argument `__getLastOtpForPhone` needs) is in scope at each of the 8 replaced call sites across the 3 integration test files.
4. Test-count accounting: `auth.test.js` grew from 25 to 26 tests (the new SEC-001 regression test); every other integration file's test count is unchanged from the audit report's own count, confirming no test was accidentally deleted while editing.

**Real confirmation of the full 216-test integration suite (plus the new 26th test in `auth.test.js`) requires GitHub Actions, per the standing process (`CLAUDE.md` Section 11).** No code was pushed in this session — that remains the project owner's step via `push.bat`. Per that same standing process, nothing in this report was treated as a fully verified "all suites still pass" claim until the real GitHub Actions result came back — see below.

---

## Real CI Confirmation (Added After Push)

The project owner ran `push.bat` and shared the real GitHub Actions result directly from the Actions UI (run `30749856109`, job "Run Backend Test Suite", `github.com/vdivcompany-cmd/Sakanify-backend/actions/runs/30749856109/job/91501841054`):

- **Job status: succeeded**, in 1m 41s. Every step shows a green check, including "Install dependencies," "Wait for MongoDB to be ready," **"Run test suite,"** and "Run health-check smoke test" — this is the step that actually executes `npm test` (all 13 Jest suite files) against a real MongoDB service container, not a mock.
- **Jest's own summary output from that run, as reported directly:**
  ```
  Test Suites: 13 passed, 13 total
  Tests:       237 passed, 237 total
  Snapshots:   0 total
  Time:        13.288 s
  Ran all test suites.
  ```

**This is the specific evidence requested, and it directly answers the two questions asked:**

1. **"Tests: X passed / Y failed"** — `237 passed, 237 total`. Zero failures.
2. **"Confirm ALL 9+ integration test files show PASS, not just an overall green checkmark"** — Jest's `Test Suites: 13 passed, 13 total` line is exactly that: a per-suite-file rollup, not a single aggregate badge. 13 total suite files matches this project's exact file count (4 unit + 9 integration), and all 13 are marked passed individually by Jest's own accounting — if even one of the 9 integration files had failed, this line would read `12 passed, 1 failed, 13 total`, not `13 passed, 13 total`.

**Cross-check against this pass's own change accounting (Section "What could NOT be executed," items above):** 237 is exactly the expected number — 18 pre-existing unit tests + 3 new (`database.config.pool.test.js`, Fix 2) = 21 unit tests, plus 215 pre-existing integration tests + 1 new (the SEC-001 regression test in `auth.test.js`) = 216 integration tests, for 21 + 216 = **237**. This match is itself confirming evidence: it means no test was accidentally duplicated or silently dropped while editing the 3 integration files for Fix 1.

**Caveat, stated plainly:** this section reflects what the project owner reported seeing in the Actions UI (a screenshot of the run page plus the pasted Jest summary text) — this session did not independently fetch or re-parse the raw GitHub Actions log itself. The run URL, per-step green checkmarks, and exact Jest summary line are taken as given, consistent with how every prior phase report in this project has treated project-owner-supplied CI results (`CLAUDE.md` Section 11: CI confirmation is inherently the project owner's step to run and report back, not something this environment can independently re-verify).

**Status: all four fixes in this pass are now fully verified — code-complete, unit-tested directly in-session, and confirmed via a real, successful GitHub Actions run with zero test failures across all 13 suite files (237/237 tests passing).**

---

## Deviations From `remediation-pass-1.md`

None. All four fixes were implemented exactly as scoped, using the specific approach the remediation instructions called for in each case (removal over env-gating for Fix 1, the `__getLastOtpForPhone` accessor pattern named explicitly in the instructions, deletion over comment-only for Fix 3 since re-confirming the grep first was straightforward). The 4 standalone `scripts/*.js` files were not explicitly named in `remediation-pass-1.md`'s file list for Fix 1, but were updated anyway since they'd have silently broken otherwise and the fix was mechanical — flagged here as a small scope addition, not a silent one, per `CLAUDE.md` Section 7.4.

## Files Changed — Full List

- `src/modules/auth/otp.service.js` (Fix 1)
- `tests/integration/auth.test.js` (Fix 1 — including 1 new test)
- `tests/integration/auth-real.test.js` (Fix 1)
- `tests/integration/students-kyc.test.js` (Fix 1)
- `scripts/test-auth-direct.js` (Fix 1, not CI-tracked)
- `scripts/test-e2e-final.js` (Fix 1, not CI-tracked)
- `scripts/test-e2e-scenarios.js` (Fix 1, not CI-tracked)
- `src/config/database.config.js` (Fix 2)
- `tests/unit/database.config.pool.test.js` (Fix 2, new file, 3 tests)
- `src/middleware/auth.middleware.js` (Fix 3)
- `src/modules/auth/auth.routes.js` (Fix 4)

## Status

**Fully verified — all 4 fixes complete, code-complete, and confirmed via a real, successful GitHub Actions run.** Unit-level and boot-level verification was real and passing in-session (21/21 unit tests, clean full-tree boot, clean project-wide syntax sweep). Integration-level verification — the piece this sandbox genuinely could not execute — is now also confirmed: GitHub Actions run `30749856109` succeeded, with Jest reporting `Test Suites: 13 passed, 13 total` / `Tests: 237 passed, 237 total`, meaning all 9 integration test files (including the 3 this pass modified, with the new SEC-001 regression test included) passed individually, not just an aggregate badge. No git commands were run by this session at any point (`CLAUDE.md` Section 11) — the push and the CI run were both the project owner's own steps, reported back per the standing process.
