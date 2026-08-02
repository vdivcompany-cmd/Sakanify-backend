# Sakanify Backend — Enterprise Engineering Audit Report

**Audit type:** Independent, project-wide, audit-only review (Phases 0–8 + the post-launch Security Hardening Pass). No code was modified as part of this audit, per the explicit mission boundary in `enterprise-audit-instructions.md` and `CLAUDE.md` Section 11 (no git operations were run either).

**Audit date:** 2026-08-02

**Auditor:** Claude (Cowork), acting as an independent reviewer — findings below were re-derived from the current state of the code, not copied from prior phase/security reports. Where this audit confirms a prior report's finding, that is stated explicitly with a citation. Where this audit found something prior reports missed, that is also stated explicitly.

**Language note:** `CLAUDE.md` Section 1 mandates Arabic for the recurring *per-phase* completion report. This document is a different deliverable — a one-time, cross-phase engineering audit — commissioned directly by the project owner with an explicit English section structure (`enterprise-audit-instructions.md`). It is written in English accordingly, consistent with its stated purpose ("a Senior Engineer who has never seen this project before could understand every issue"). If Arabic is actually wanted for this document too, say so and it will be redone.

---

## 1. Executive Summary

The Sakanify backend (Phases 0–8, plus a subsequent Security Hardening Pass) is, on the whole, **well-engineered for its stage**: the single highest-risk mechanic in the entire system — atomic bed locking to prevent double-booking — is implemented correctly with a genuine single-document conditional `findOneAndUpdate`, not an approximation. Ownership scoping, mass-assignment whitelisting, audit logging, and pagination are applied consistently across every live module, and background jobs are batched correctly for the project's target scale (~500K students). The prior Security Hardening Pass (`Docs/reports/security-hardening-report.md`) was thorough and its claimed fixes were independently re-verified in this audit as genuinely present in the current code (JWT algorithm pinning, CORS allowlist, EXIF stripping, the two post-CI regression fixes for KYC-upload-rejection status code and the rate-limiter/test-suite-size interaction).

However, this audit found **one critical, previously undocumented vulnerability that materially changes the security posture**: the `POST /api/auth/request-otp` endpoint returns the actual OTP code in its JSON response body, unconditionally, in every environment — including production — with no `NODE_ENV` gating anywhere in the call chain (`otp.service.requestOtp` → `auth.controller.requestOtp` → `response.util.success`). Combined with the OTP being logged to console as well, this means the phone-possession factor of student authentication provides **no real security today**: anyone who can call the endpoint for a given phone number receives the code needed to complete login for that number, without ever needing SMS access. This was not flagged by the prior Security Hardening Pass, whose OTP review focused on brute-force resistance (rate limiting the *verify* step) rather than response-body leakage of the *request* step. See **SEC-001** below — this is the single most severe finding in this audit and is a **Critical Production Blocker**.

Beyond that, the remaining gaps are consistent with what the project's own prior reports already flagged as deferred, documented decisions (no Super-Admin MFA, in-memory rate limiter not safe for horizontal scaling, `langchain`/`node-cron` dependency vulnerabilities) — this audit independently re-confirmed each of those rather than assuming they were still accurate, and found no material change in any of them. This audit also found one new, previously undocumented (but low-severity) gap: MongoDB connection pooling is never explicitly configured (`CLAUDE.md` Section 4.3 requires this explicitly, and it is not done), and one code-hygiene item: an unused `ownershipScopingMiddleware` helper with a weaker trust pattern than the one actually used everywhere else in the codebase.

**Test evidence honesty note:** This sandbox could execute the full unit test suite directly (17/17 passing) and `npm audit` directly (10 vulnerabilities: 1 high, 9 moderate — exact match to the prior report). It could **not** execute the integration test suite (~215 tests across 9 files), because `mongodb-memory-server`'s binary download domain (`fastdl.mongodb.org`) is blocked by this sandbox's network egress allowlist (`403 blocked-by-allowlist`, confirmed directly with `curl`) — this is a more precise diagnosis than prior reports' generic "network-restricted sandbox" note, and it is *not* a general network block: `npm audit`/npm registry access worked fine from the same sandbox. Integration-test correctness in this report therefore rests on (a) historical, citable GitHub Actions runs recorded in the individual phase reports, and (b) this audit's own manual code tracing — never on fabricated re-execution. This is stated explicitly wherever it applies, per the audit brief's Honesty Requirement.

---

## 2. Audit Scope

Reviewed in full: Backend Architecture, Authentication, Authorization/Ownership Scoping, Business Logic (booking engine, payments, subscriptions, utility billing), APIs (all 9 mounted routers), MongoDB (schemas, indexes, query patterns, transaction/concurrency risk), Error Handling, Audit Logging, Dependency Security, DevOps/CI Readiness, and Deployment Readiness.

Assessed via static/code-based review only (see Honesty Requirement, Sections 6–7 below for why): Performance under real load, Load Testing, live infrastructure (MongoDB Atlas IP allowlist, TLS termination, backup/restore).

Not in scope / genuinely inapplicable today: the 3 unmounted modules (`owners`, `messages`, `ai-assistant`) have no live HTTP surface (confirmed by reading `src/app.entry.js` — none of their routers are `require()`'d or mounted), so they are reviewed only for inventory/future-risk purposes (Section 11), not as active attack surface.

Documents used as ground truth, all read in full: `CLAUDE.md`, `Docs/00-overview.md`, `Docs/phase-0-foundation.md` through `Docs/phase-8-public-site.md`, `Docs/reports/phase-0-foundation-report.md` through `Docs/reports/phase-8-public-site-report.md`, and `Docs/reports/security-hardening-report.md`.

---

## 3. Complete Test Log

### 3a. Tests actually executed in this session (real, reproducible evidence)

| Test Name | Objective | Scenario | Expected | Actual | Status | Notes |
|---|---|---|---|---|---|---|
| `tests/unit/metadata-strip.util.test.js` (8 tests) | Verify EXIF/GPS metadata stripping from JPEG/PNG/WEBP | Run full Jest suite, no DB required | All 8 pass | All 8 passed (8.1s) | ✅ Passed | Executed directly via `node ./node_modules/jest/bin/jest.js`. One benign `console.warn` observed for a malformed test fixture — expected fail-safe path, not an error. |
| `tests/unit/error-handler.normalize.test.js` (6 tests) | Verify `normalizeError()` classification + prod-message redaction | Run full Jest suite | All 6 pass | All 6 passed | ✅ Passed | Confirms the central error-handling fix from the Security Hardening Pass is genuinely in the code, not just described. |
| `tests/unit/auth-jwt-algorithm.test.js` (3 tests) | Verify JWT algorithm pinning (HS256) rejects HS384/`alg:none` forged tokens | Run in isolation | All 3 pass | All 3 passed (20.3s — see note) | ✅ Passed | Took ~19s to boot (module require chain), not a hang — confirmed by re-running via the direct Jest binary instead of `npx`, which was adding ~15-20s of resolution overhead per invocation. |
| `npm audit --json` | Enumerate known-vulnerable dependencies | Run against the current `package-lock.json` | Matches prior report (10 total) | **10 vulnerabilities: 1 high, 9 moderate, 0 critical** — identical package set to `security-hardening-report.md` (`@langchain/*`, `langsmith`, `node-cron`, `uuid`) | ✅ Confirmed, unchanged | Independently re-run, not copied from the prior report. |
| `git ls-files \| grep -E "^\.env$\|atlas-credentials"` | Confirm no secret file is tracked by git | Search tracked file list | No matches | No matches | ✅ Passed | `.env` and `atlas-credentials.env` are not, and have never been, committed. |
| Direct network probe: `curl -sI https://fastdl.mongodb.org/` | Diagnose why integration tests can't run here | Probe the exact domain `mongodb-memory-server` downloads from | N/A (diagnostic) | `403 Forbidden`, `X-Proxy-Error: blocked-by-allowlist` | Diagnostic | Confirms this sandbox has a specific egress allowlist blocking the MongoDB binary CDN — not a blanket network outage (`npm audit`/registry access succeeded from the same sandbox in the same session). |
| Manual trace: `file-storage.adapter.js` `UnsupportedFileTypeError` | Verify the "KYC 500 regression" fix is actually present | Read the class constructor | `this.statusCode = 400` present | Present, exactly as described in the hardening report's regression-fix section | ✅ Confirmed fixed | See Section 4, SEC-REGR-1. |
| Manual trace: `rate-limiter.middleware.js` | Verify the "429 on buildings/audit" regression fix is actually present | Read the limiter config | `skip: () => process.env.NODE_ENV === 'test'` present | Present | ✅ Confirmed fixed | See Section 4, SEC-REGR-2. |
| Manual trace: `bed.repository.conditionalUpdateStatus` + `request.service.createRequest` | Verify the atomic bed-locking guarantee is a real single-document conditional update, not an approximation | Read the full request confirm/reject/expire/create code path | A single `findOneAndUpdate({_id, status: expected}, {$set:{status:new}})` with a `null`-on-race-loss contract | Confirmed exactly this; rollback-on-failure-after-lock path also present and logged | ✅ Confirmed sound | This is the project's single highest-risk mechanic and it is implemented correctly. |
| Manual trace: `payment.repository.atomicConfirm` usage in `payment.service.confirmPayment` | Verify concurrent cash-payment confirmations can't lose an update (CLAUDE.md 6.2) | Read `confirmPayment()` | Atomic accumulate-and-derive-status update, not read-then-write | Confirmed: `paymentRepository.atomicConfirm()` is a single Mongo update, the earlier `getPaymentById` read is only used for the 404/409 pre-check and default-remaining-balance calculation | ✅ Confirmed sound | |
| Manual trace: `POST /api/auth/request-otp` full response path | Verify OTP delivery cannot be intercepted via the API response itself | Traced `otp.service.requestOtp` → `auth.controller.requestOtp` → `response.util.success` | OTP code should never appear in the HTTP response body outside of a gated dev/test path | **The full `otpService.requestOtp()` return value, including `_dev_code` (the real OTP), is returned verbatim to the client with zero `NODE_ENV` gating anywhere in the chain** | 🔴 **Failed — new critical finding** | See **SEC-001**. Independently discovered in this audit; not present in any prior report. |
| Manual trace: model index coverage (all 15 live `*.model.js` files) | Confirm every owner/status/lookup field is indexed per CLAUDE.md 4.1 | `grep` every model for `.index(`/`unique` | Full coverage on all live modules | Confirmed for all 13 live modules; `owners`/`messages` models (unmounted, dead code) have **no** indexes at all | 🟡 Informational | Not a live risk today — see Section 11. |
| Manual trace: `database.config.js` connection setup | Confirm explicit connection-pool configuration per CLAUDE.md 4.3 | Read `mongoose.connect()` call | Explicit `maxPoolSize`/pool options | **No pool options passed at all** — bare `mongoose.connect(env.mongodbUri)` | 🟡 **Failed — new finding** | See **DB-001**. |

### 3b. Integration test suites — NOT re-executed in this session (see Honesty Requirement)

These could not be run here due to the `fastdl.mongodb.org` allowlist block described above. The table below cites the historical, real CI evidence already on record in the project's own phase reports (each with a real GitHub Actions run link), rather than re-asserting pass/fail without evidence:

| Suite | Test count (counted directly from source, `it(`/`test(` occurrences) | Last independently-documented real CI result | Source |
|---|---|---|---|
| `tests/integration/auth.test.js` + `auth-real.test.js` | 25 + 9 = 34 | Passing as of Phase 1's GitHub Actions run (cited in `phase-1-auth-report.md`) | Phase 1 report |
| `tests/integration/students-kyc.test.js` | 17 | Run #4, Success — `github.com/vdivcompany-cmd/Sakanify-backend/actions/runs/30663307013` | Phase 2 report |
| `tests/integration/buildings-apartments-beds.test.js` | 34 | Run #5, Success — `.../runs/30689315259`; later grew by 3 more tests (subscription-capacity hardening) not yet independently CI-confirmed per the hardening report itself | Phase 3 report; hardening report |
| `tests/integration/booking-engine.test.js` | 38 | Code-complete per Phase 4 report; push/CI confirmation was pending at that report's time of writing (documented `index.lock` blocker) | Phase 4 report |
| `tests/integration/cash-payment.test.js` | 26 | Run #10, Success (including the explicit concurrent-partial-payment test required by CLAUDE.md 6.2) | Phase 5 report |
| `tests/integration/subscriptions-utilities.test.js` | 23 | Code-complete per Phase 6 report; CI confirmation pending at that report's time of writing | Phase 6 report |
| `tests/integration/admin.test.js` | 22 | Code-complete per Phase 7 report; CI confirmation pending at that report's time of writing | Phase 7 report |
| `tests/integration/public-site.test.js` | 21 | Code-complete per Phase 8 report; CI confirmation pending at that report's time of writing | Phase 8 report |
| Post-hardening full run | — | **225/232 → 232/232** after the two regression fixes (KYC-upload status code, test-env rate-limiter skip) | `security-hardening-report.md`, "Regressions Found & Fixed" section |

**This audit's independent contribution here** is not re-running these (impossible in this sandbox) but manually tracing the specific mechanics each suite is supposed to protect (atomic bed lock, atomic payment confirm, both regression fixes, ownership scoping, mass-assignment whitelisting) directly against the current source, confirming the code matches what the tests are described as asserting. No integration-test pass/fail number in this report should be read as freshly re-verified by this audit — only the unit tests, `npm audit`, and the manual code traces in Section 3a are this audit's own fresh evidence.

---

## 4. Security Findings

| ID | Severity | Description | Attack Scenario | Potential Damage | Recommended Fix | OWASP / CWE |
|---|---|---|---|---|---|---|
| **SEC-001** | **Critical** | `POST /api/auth/request-otp` returns the real OTP code in its JSON response body (`data._dev_code`) in **every** environment, with no `NODE_ENV` check anywhere in `otp.service.requestOtp` → `auth.controller.requestOtp` → `response.util.success`. The code is also written to `console.log` unconditionally. | Attacker calls `POST /api/auth/request-otp` with any target phone number, reads the OTP directly from the response, then immediately calls `POST /api/auth/verify-otp` with that phone+code to obtain valid access/refresh tokens for that student — or to create a brand-new account for a phone number that isn't registered yet. No SMS interception, no social engineering, no brute force needed. | Complete authentication bypass for the entire student user base: full account takeover (KYC data, personal profile, request/rental history) for any known or guessable phone number, at will, for as long as this ships. This is the single most severe issue found in this audit. | Never include the raw OTP code in the HTTP response. Gate `_dev_code` behind an explicit, narrow check (e.g. `env.nodeEnv !== 'production'` **and** a dedicated dev flag, not just `NODE_ENV=test`/`development` alone, since staging environments often also run in `development` mode) — or better, remove the field from the API response entirely and have tests read the code directly from the test database/mock SMS log instead of the HTTP response. Also stop logging the raw code to stdout unconditionally once a real SMS provider is wired in. | OWASP API2:2023 – Broken Authentication; CWE-522 (Insufficiently Protected Credentials), CWE-200 (Exposure of Sensitive Information) |
| **SEC-002** | High (documented, deferred by explicit project-owner decision — re-confirmed unresolved) | No MFA (TOTP or otherwise) for Super-Admin accounts, the single highest-value account type in the system (suspend/impersonate/full data access). | An attacker who obtains a Super-Admin's email/password (phishing, credential-stuffing, password reuse) gets full platform access with only one factor. | Full platform compromise: every owner's and student's data, impersonation capability, account suspension. | Implement TOTP-based MFA for the `super-admin` role before real production launch. | OWASP API2:2023 – Broken Authentication |
| **SEC-003** | High (1 pkg) / Moderate (9 pkgs) — documented, deferred by explicit project-owner decision, re-confirmed unchanged | `npm audit`: 10 vulnerabilities, all in two dependency trees: `langchain`/`@langchain/*`/`langsmith` (SSRF via trace-header injection + prototype pollution + streaming-redirect leak — High) and `node-cron` (via an outdated transitive `uuid` — Moderate). | The `langchain`/`ai-assistant` tree has **zero live attack surface today** — independently re-confirmed: `ai.routes.js` is not `require()`'d anywhere in `app.entry.js`. `node-cron`, however, **is** live — it drives `request-expiry.job`, `payment-rollover.job`, and `overdue-check.job`, all of which run on a fixed schedule with no external input, so the practical exploitability of its `uuid` issue in this specific usage is low, but the dependency itself is still flagged. | Currently low practical risk given the above, but both trees carry real CVEs and a breaking-change upgrade (`npm audit fix --force`) is the only available remediation for either. | Track as a planned, tested upgrade task (not urgent given current exposure, but should not be deferred indefinitely) — `node-cron@4.x` and `@langchain/core@1.x`/`langchain@1.x` both require dedicated regression testing before upgrading, per the existing hardening report's own reasoning, which this audit found still sound. | Depends on package: SSRF (CWE-918), Prototype Pollution (CWE-1321) |
| **SEC-004** | Medium (documented, deferred — pre-launch checklist item, re-confirmed unresolved) | Rate limiting (`express-rate-limit`) uses the default in-memory store everywhere (global limiter, OTP/login/password-reset limiters, public-site limiters) — confirmed by reading every limiter definition in the codebase; none use a shared store like Redis. | Once the backend is deployed as more than one instance (horizontal scaling, which the project's own scale target of ~500K students will eventually require), each instance has its own independent rate-limit counters — an attacker distributing requests across instances (e.g. via a load balancer with multiple backend replicas) effectively multiplies their allowed request rate by the instance count. | Reduced effectiveness of brute-force/OTP-spam/abuse protections at scale — not exploitable today (single-instance deployment), but a real gap the moment horizontal scaling is introduced. | Move to a shared store (Redis-backed `rate-limit-redis`, consistent with the `@upstash/redis` dependency already present in `package.json`) before deploying more than one instance. | OWASP API4:2023 – Unrestricted Resource Consumption |
| **SEC-005** | Low / Informational | `ownershipScopingMiddleware` in `auth.middleware.js` is exported but **never used anywhere in the codebase** (confirmed via project-wide `grep`) — every live ownership check instead uses the explicit "fetch resource, then call `ownershipScoping(authOwnerId, resource.owner_id)`" pattern. The unused middleware trusts `req.params.ownerId`/`req.body.owner_id` (client-supplied) directly rather than a value read back from the database, which is a structurally weaker pattern than the one actually in use. | None today — dead code, unreachable from any route. | None today. Risk is entirely latent: a future developer could wire this specific helper into a new route without noticing it's weaker than the codebase's established pattern. | Either delete the unused export, or add a code comment/lint rule steering future use toward the resource-fetch-then-compare pattern instead. | OWASP API1:2023 – Broken Object Level Authorization (latent, not currently exploitable) |
| **SEC-006** | Informational | `POST /api/auth/refresh-token` is the one auth endpoint with **no** rate limiter (every other auth endpoint — OTP request/verify, login, password reset — has one). | Low practical exploitability: refresh tokens are unguessable 256-bit-class JWTs, so this isn't a brute-forceable surface. | Minimal — mostly a consistency gap against CLAUDE.md Section 3.7's blanket "rate-limit all authentication endpoints" rule. | Add a generous rate limiter for consistency/defense-in-depth. | OWASP API4:2023 – Unrestricted Resource Consumption |
| **SEC-007** | Informational (re-confirmed, unchanged from prior report) | CORS `ALLOWED_ORIGINS` defaults to empty (no browser origin trusted) — safe by default, but no real frontend origin is configured yet. | None — this is the *safe* state. | N/A | Must be set to the real frontend domain(s) before frontend integration, or the frontend will be unable to call the API from a browser. Already tracked as a pre-launch checklist item in the hardening report; re-confirmed still accurate. | — |

**Re-verified, unchanged from the Security Hardening Pass (not re-derived from scratch, but independently spot-checked against current code, not just trusted at face value):** JWT algorithm pinning (`HS256` explicit on every `sign`/`verify` call — confirmed in `auth.service.js` and `admin.service.js`), CORS allowlist logic, EXIF/GPS metadata stripping wired into every upload path, mass-assignment whitelisting (`zod` schemas + manual field allowlists — spot-checked `student.validation.js` directly, matches the prior report's description exactly), magic-byte file-type sniffing (not extension/MIME-header trust), `.env`/`atlas-credentials.env` never committed to git (re-confirmed via `git ls-files`), and both post-CI regressions (KYC-upload 500→400 fix, rate-limiter/test-suite-size 429 fix) genuinely present in the current source, not just described in the report.

---

## 5. Business Logic Findings

1. **Atomic bed locking (Phase 4) — sound.** `bed.repository.conditionalUpdateStatus` is a genuine single-document `findOneAndUpdate` with a status-match filter; `request.service.createRequest`/`confirmRequest`/`rejectRequest`/`expireRequest` all route through it correctly, including an explicit rollback-with-logging path if request-document creation fails after the bed lock succeeds. This is the project's highest-risk mechanic and it is implemented correctly.
2. **Duplicate-request cap (max 2 pending per student) is a soft, non-atomic check** (count-then-create) — the code's own comment correctly identifies this as an acceptable, narrow TOCTOU gap (worst case: a student briefly exceeds the cap by one), explicitly distinguished from the hard atomic guarantee on the bed itself. This audit agrees with that risk classification.
3. **Subscription bed-capacity enforcement (Category 9/F hardening fix) is also a soft, non-atomic check** (count-then-compare in `bed.controller.createBed`), by the same reasoning and with the same documented, project-owner-approved risk acceptance (a billing/plan-limit concern, not a data-integrity or cross-owner-isolation failure). This audit agrees this is a reasonable, explicitly-accepted trade-off, not a defect.
4. **Payment confirmation concurrency (Phase 5) — sound.** `payment.repository.atomicConfirm` performs the accumulate-and-derive-status write as a single atomic Mongo operation; the preceding read is used only for pre-validation (404/409/default-amount), not as the source of truth for the write, which is the correct pattern to avoid a lost-update race under concurrent partial-payment confirmations.
5. **Utility bill splitting (Phase 6)** — reviewed the split/rounding logic and the "reject if utilities are bundled in rent" / "reject if zero active rentals" guards described in the phase spec; the implementation in `utility-bill.service.js` matches the spec's described behavior on inspection. This was **not** independently re-executed against the rounding-remainder edge case in this session (that lives in the integration suite this sandbox cannot run) — flagged under Missing Tests (Section 14) rather than asserted as verified.
6. **Suspend → guard-clause chain (Phase 7)** — `admin.service.suspendOwner` genuinely flips both `subscription.status` (which is what `subscriptionService.canAcceptNewRequests()` actually checks) **and** the owner's `User.status` plus immediate token invalidation, not a cosmetic flag — confirmed by reading the full call chain, not just the report's description of it.
7. **OTP leakage (SEC-001) is also a business-logic-adjacent failure**, not purely a "security" checkbox item: it defeats the entire "students authenticate via phone possession" business rule from `Docs/00-overview.md`. Listed under Security Findings for OWASP mapping, but flagged here too since it undermines a core business assumption, not just a technical control.

---

## 6. Performance Findings

**Honesty label per the audit brief:** everything in this section is a **code-based/theoretical assessment**, not a measured result — this sandbox has no live deployed instance and no ability to generate sustained load against a running server. No response-time, throughput, or requests/second figures are given anywhere below, because none were measured.

1. **No explicit MongoDB connection pool configuration** (`database.config.js` calls `mongoose.connect(env.mongodbUri)` with zero options). This directly contradicts `CLAUDE.md` Section 4.3 ("Configure MongoDB connection pooling explicitly rather than relying on default settings"). At low load this is invisible; at the project's stated target (~500K students, high concurrent request volume during term-start peaks) an untuned default pool size is a real, foreseeable bottleneck. See **DB-001**.
2. **Pagination is universally enforced** (`MAX_LIMIT = 100`, confirmed in `pagination.util.js` and applied to every list endpoint reviewed) — no "return everything" endpoint exists, which is exactly the right posture for the target scale.
3. **Background jobs are correctly batched** (`BATCH_SIZE` 100–200 across `request-expiry.job`, `payment-rollover.job`, `overdue-check.job`), never loading a full collection into memory, and each batch iteration is independently error-handled so one bad document doesn't abort a sweep.
4. **Aggregation pipelines are used correctly for cross-owner/platform-wide metrics** (Phase 7's `getPlatformMetrics`, `listOwnersOverview`) rather than per-row application-level loops — confirmed by reading `admin.service.js` directly; matches the batched-lookup pattern (buildings/beds/subscriptions fetched once per page via `$in`, not per-owner).
5. **In-memory rate limiting** (see SEC-004) is as much a performance/scalability concern as a security one — it is the one piece of the request path not designed for horizontal scale-out.

---

## 7. Load Testing Findings

**Honesty label:** no load test was executed — this sandbox cannot generate sustained concurrent traffic against a running instance, and doing so against the real MongoDB Atlas cluster without the project owner's explicit sign-off would also be inappropriate for an audit-only engagement. Everything below is a structural read of what *would* need to be verified, not a result.

1. **Concurrent bed-request race** — the correctness of the atomic lock (Section 5, item 1) was verified by code tracing, not by firing simultaneous real requests at a live server in this session. The project's own Phase 4 report states this was tested via Jest's concurrent-`Promise.all()`-style integration tests, which this sandbox could not re-execute (Section 3b). **Recommend**: re-run that specific test class against real GitHub Actions (already historically done, per the Phase 4/5 reports) before treating it as re-confirmed for this audit's purposes, and — ideally — a real concurrent load test against a staging deployment before the first real multi-tenant peak (start of academic term).
2. **Payment confirmation race under load** — same caveat as above; the atomic-update pattern is structurally sound (Section 5, item 4), but was not exercised under real concurrent load in this session.
3. **Public-site endpoints under scraping/bot load** — `browsingLimiter` (120 req/15min) and `leadLimiter` (5 req/15min) are IP-keyed and in-memory (SEC-004 applies here too); no CDN/edge caching layer was found in front of the public listing/counters endpoints, which the Phase 8 spec itself flagged as "a reasonable future optimization, not required to build now" — still not built, which is consistent with the spec's own stated scope, not a new gap.
4. **No load-testing tooling or scripts** (k6, Artillery, autocannon, etc.) were found anywhere in the repository (`scripts/`, `package.json` devDependencies). This is expected at this project stage but is worth noting explicitly as a **Missing Test** (Section 14) before production launch.

---

## 8. Database Findings

1. **DB-001 (new finding, Medium severity): No explicit connection pool configuration.** `mongoose.connect(env.mongodbUri)` is called with no `maxPoolSize`/`minPoolSize`/`serverSelectionTimeoutMS` options anywhere in `database.config.js`. This is a direct, unambiguous gap against `CLAUDE.md` Section 4.3. Practically: the MongoDB Node.js driver's own default (`maxPoolSize: 100` in recent driver versions) will apply, which may or may not be appropriate for this project's actual expected concurrency — the point of the CLAUDE.md rule is that this should be a *deliberate, documented* value, not whatever the driver defaults to. **Recommend**: add explicit `maxPoolSize`/`minPoolSize` options (and a `serverSelectionTimeoutMS` — see also Section 12, Reliability, on the indefinite-hang risk this omission also creates) sized to the deployment's actual expected concurrent connections.
2. **Indexing is comprehensive across all live modules** (Section 3a table) — every owner-scoping field, status field, and lookup field reviewed has an explicit index, matching CLAUDE.md 4.1 exactly. The two unmounted/dead modules (`owners`, `messages`) have zero indexes, which is a non-issue today (zero query traffic) but would need to be added before either module is ever activated.
3. **Unique constraints are used correctly** where the business rules require them: `{email}`/`{phone}` sparse-unique on `User` (Phase 1's requirement), `{rental, billing_period}` unique on `Payment` (prevents duplicate billing records — the actual mechanism the rollover-idempotency guarantee depends on), `{student}` unique on `Kyc`, `{jti}` unique on `ImpersonationSession`.
4. **No `.populate()` calls exist anywhere in the codebase** (re-confirmed via project-wide search, matching the prior security report's finding) — every cross-collection read goes through an explicit service call with its own field selection, which is both a sound N+1-avoidance pattern and incidentally closes off an entire class of accidental `select:false` field leakage via populate.
5. **N+1 avoidance is consistently applied** for every nested/aggregate read reviewed (owners-overview table, building→apartment→bed nested read, platform metrics) — batched `$in` lookups keyed by the current page's IDs, never a per-row query loop.
6. **Transaction usage**: no `mongoose.startSession()`/multi-document ACID transactions were found anywhere in the codebase. This is **not** a defect given the architecture: every genuinely atomicity-sensitive operation (bed lock, payment confirm) is deliberately designed as a *single-document* conditional update instead, which sidesteps the need for a multi-document transaction (and the additional operational complexity of requiring a replica-set-backed Atlas cluster for transaction support) entirely. This is a sound architectural choice, not an oversight — worth stating explicitly since "no transactions" can look like a gap in isolation.

---

## 9. API Findings

1. **Standardized response shape is applied with zero exceptions** across every controller reviewed (`{success, message, data}` / `{success, message, errors}`) — confirmed by reading `response.util.js` and spot-checking multiple controllers.
2. **Error classification (`normalizeError()`) is now the single funnel point for every controller** — re-confirmed genuinely wired into all previously-flagged legacy controllers (`auth`, `audit`, `student`, `kyc`, `building`, `apartment`, `bed`), matching the hardening report's description exactly, not just claimed.
3. **SEC-001 (OTP leakage) is fundamentally an API design/response-shape defect** as much as an auth defect — the fix belongs in the response construction, not deeper in the auth logic (see Section 4).
4. **`refresh-token` endpoint lacks a rate limiter** — see SEC-006 (low severity, consistency gap).
5. **Every list endpoint reviewed supports pagination with a bounded `MAX_LIMIT`** — no exceptions found.
6. **Public-site API correctly avoids exposing sensitive/internal data**: no bed-by-bed availability map, no owner internal fields, no student PII, confirmed by reading `public.service.js`'s field selection directly against the Phase 8 spec's explicit data-minimization requirement.

---

## 10. Authorization Findings

1. **Role-guard middleware (`requireRole`) is applied at the router level, not inside individual controllers**, for every module reviewed — this means a newly added route under an already-`router.use(verifyToken, requireRole(...))`-protected router inherits protection automatically, which is a materially safer default than per-controller checks that could be forgotten on a new route. Confirmed directly for the `admin` module (`router.use(verifyToken, requireRole(SUPER_ADMIN))` as the very first line).
2. **Ownership scoping follows a single, consistent pattern everywhere it's live**: fetch the resource, then call `ownershipScoping(req.user.ownerId, resource.owner_id)` before any further action — confirmed directly in the request/payment/rental control flow, not just trusted from the prior report's table.
3. **The one exception — `ownershipScopingMiddleware`** — is unused dead code with a structurally weaker (client-trusting) pattern; see SEC-005. Not a live authorization gap, but worth fixing before anyone reaches for it.
4. **Impersonation authorization is distinct and correctly scoped**: impersonation tokens carry `type: 'impersonation'`, are checked against a live, revocable `ImpersonationSession` record (by `jti`) on every request — not just JWT signature/expiry — and are deliberately exempted from the *target* owner's own suspension check (by design, so a Super-Admin can still impersonate a suspended owner for support purposes) while still being rejected if the *impersonating admin's own* account becomes inactive mid-session. This is a subtle, correctly-reasoned design, confirmed by reading `auth.middleware.verifyToken`'s impersonation branch directly.
5. **Subscription data requires no separate ownership-scoping check** because it's always derived from `req.user.ownerId` server-side, never from a client-supplied resource ID — correctly noted as "not applicable" rather than "missing" in the prior report, and re-confirmed here.

---

## 11. Architecture Findings

1. **Modular monolith structure is followed consistently** — every live module has its own routes/controller/service/repository/model, and cross-module access goes through service functions, not direct model imports (spot-checked `request.service.js`, `payment.service.js`, `admin.service.js` — all correctly avoid reaching into another module's model/repository directly).
2. **Three fully-scaffolded but unmounted modules exist**: `owners`, `messages`, `ai-assistant` (the last one has real logic in `langchain.service.js`/`langgraph.workflow.js`, consistent with `Docs/00-overview.md`'s stated "AI Agentic Automation Layer comes after the backend" roadmap item — its presence pre-built is a forward-looking scaffold, not scope creep, but it is inventory that needs tracking). None are `require()`'d in `app.entry.js` — re-confirmed directly, zero live HTTP surface. This matches the prior security report's Category J finding exactly; re-confirmed still accurate and unchanged. **Risk is entirely latent**: if a future developer mounts any of these without first re-applying the ownership-scoping/mass-assignment/audit-logging patterns used everywhere else, that new surface would ship without the same hardening the rest of the project has. Recommend either a tracking ticket or a prominent code comment at the top of each unmounted module's routes file.
3. **Load-order/circular-dependency avoidance is handled deliberately and correctly** in the few places it was a real risk (bed-capacity check placed in the controller rather than the service specifically to avoid a `bed.service → subscription.service → bed.service` cycle; `payment.service`/`rental.service`'s one-directional dependency documented explicitly in code comments). This is a sign of real architectural discipline, not accidental avoidance.
4. **`ai-assistant`'s dependency tree (`langchain`/`@langchain/*`/`langsmith`) is the source of 7 of the 10 `npm audit` findings** (Section 4, SEC-003) despite having zero live functionality yet — worth flagging as a cost/risk trade-off for the project owner: carrying these dependencies pre-emptively for a not-yet-built feature has an ongoing security-maintenance cost (audit noise, eventual forced upgrade) even while contributing zero current attack surface.

---

## 12. Reliability Findings

1. **Graceful shutdown is implemented correctly**: `server.entry.js` handles `SIGINT`/`SIGTERM`, stops all scheduled jobs, and closes the HTTP server before exiting — confirmed by reading the full shutdown handler.
2. **Scheduled jobs are individually fault-isolated**: `scheduler.core.js` wraps every job handler in its own try/catch, logging failures without crashing the process or blocking other jobs — confirmed directly.
3. **DB connection retry logic exists but has no maximum wait cap** beyond `MAX_RETRIES = 5` at a fixed `5000ms` delay, after which the process calls `process.exit(1)`. This is a reasonable fail-fast posture for a container-orchestrated deployment (let the orchestrator restart it) but is worth stating as a deliberate choice, not an oversight.
4. **No `serverSelectionTimeoutMS` is configured** (ties back to DB-001) — combined with the retry logic above, a genuinely unreachable database at startup will still take up to `5 × (driver's default server-selection timeout, ~30s)` before even reaching the first retry's `catch` block, i.e. minutes before the process gives up and exits, rather than failing fast. This was observed indirectly in this very audit session: attempting to load `auth.service.js` (which transitively loads `env.config.js`, though notably **not** `database.config.js`'s `connectDB()` — that's never called at module-load time, only from `server.entry.js`) took an unexpectedly long time under `npx` overhead, which is a separate, unrelated finding (tooling overhead, not a code defect) but underscores why explicit, short timeouts matter for fast, legible failure.
5. **Idempotency is handled correctly** for the two jobs where it matters most: `payment-rollover.job` (unique `{rental, billing_period}` index + existence check before insert) and `request-expiry.job` (re-reads request/bed state before acting, no-ops safely if an owner responded in the same window).

---

## 13. Edge Cases

Reviewed and confirmed handled correctly by code tracing:
- Bed reaching *exactly* its subscription capacity limit (not over) is still allowed to be created — confirmed in `bed.controller.createBed`'s `>=` comparison.
- An owner with no subscription provisioned at all is treated as uncapped (both for bed creation and for `canAcceptNewRequests`) — a deliberate, documented choice specifically so Phase 3's pre-existing test fixtures (which predate Phase 6 subscriptions) don't spuriously fail.
- A rental billing period request that lands on a still-future calendar month is never generated early by the rollover job — explicit `nextPeriod > currentPeriod` guard.
- A payment already fully `PAID` correctly rejects a further confirmation attempt with 409, both at the pre-check and, more importantly, atomically at the actual write (so a race between two confirmations can't double-collect).
- Owner suspension against an owner with **no** subscription record throws a clear 404 rather than silently suspending only half the intended effect (User status flips but the request-blocking guard clause — which depends on subscription status — would not actually engage) — this is flagged in `admin.service.js`'s own code comments as a known edge case, and this audit agrees with treating it as "fail loudly" rather than "silently incomplete."

Reviewed but **not independently exercised** in this session (would require the integration suite this sandbox cannot run) — flagged instead under Missing Tests:
- The utility-bill rounding-remainder case (a bill that doesn't divide evenly across active students).
- Simultaneous requests from the *same* student racing the 2-pending-request soft cap.
- Simultaneous bed-creation calls racing the subscription-capacity soft cap.

---

## 14. Missing Tests

1. **A real concurrent-load test against a staging deployment** for the bed-locking and payment-confirmation atomic paths — the existing Jest tests exercise concurrency via `Promise.all()` within a single test process, which is good evidence but is not the same as verifying behavior under genuine network-level concurrency/latency variance against a real MongoDB Atlas cluster.
2. **A test specifically asserting `_dev_code` (or any raw OTP value) is absent from the `POST /api/auth/request-otp` response when `NODE_ENV=production`** — does not exist today (unsurprising, since the bug itself means no such gating exists to test). Should be added alongside the SEC-001 fix.
3. **A load/soak test for the public-site endpoints** (`/api/public/*`) simulating realistic scraping/bot traffic against the in-memory rate limiter, to characterize its actual behavior under sustained abuse rather than the current single-instance, low-volume assumption.
4. **A restore-from-backup drill** for MongoDB Atlas — explicitly flagged as not yet done in the prior hardening report's pre-launch checklist; re-confirmed still an open item (infrastructure, not code, so outside what this audit could verify directly).
5. **An explicit unit test for `database.config.js`'s connection-pool/timeout configuration** once DB-001 is fixed, to prevent the fix from silently regressing.
6. **A dependency-upgrade regression test plan for `node-cron`** specifically (the live, in-use vulnerable package) — before attempting the breaking-change upgrade `npm audit fix --force` would apply.

---

## 15. Assumptions

- This audit assumes the historical GitHub Actions run links cited in Section 3b are genuine and were not fabricated by prior sessions — they were not independently re-visited/re-fetched in this audit (no web access to private GitHub Actions logs was available or appropriate here); they are cited as "what the project's own prior reports claim," not as independently re-confirmed URLs.
- This audit assumes the `.env` file present in the repository root (not read in full, and never will be — it contains live credentials) matches what `env.config.js`'s `REQUIRED_VARS`/`STORAGE_VARS` expect; only the *shape* of environment-variable handling was reviewed, never actual secret values.
- This audit assumes the MongoDB Atlas IP allowlist, TLS termination, and backup configuration described as "not yet confirmed" in the prior hardening report are still in that same state — this could not be independently re-checked from this sandbox (no access to the Atlas console), so it is carried forward as an open item rather than re-verified.
- This audit assumes "production" in this codebase is fully determined by `NODE_ENV=production` with no separate staging-specific flag — if a staging environment actually runs with `NODE_ENV=production` for parity reasons, some of this report's environment-gating recommendations (e.g. for SEC-001's fix) would need a more specific flag than `NODE_ENV` alone; if it runs as `NODE_ENV=development`/`staging`, the current total absence of gating is even more exposed than described, since even a "should be safe" non-production deploy would leak the OTP today.

---

## 16. Production Risks (Highest to Lowest)

1. **SEC-001 — OTP code leaked in the request-otp API response.** Complete authentication bypass for the student user base. Must fix before any real user data flows through this system.
2. **SEC-002 — No Super-Admin MFA.** Full-platform-compromise blast radius on a single-factor account type.
3. **DB-001 — No explicit connection pooling.** Silent degradation risk that will only surface under real production concurrency, at the worst possible time (peak load).
4. **SEC-004 — In-memory rate limiting.** Silently loses effectiveness the moment the deployment scales beyond one instance, with no error or warning signal that this happened.
5. **SEC-003 — `node-cron` (live) and `langchain` (dormant) dependency vulnerabilities.** Real CVEs, currently low practical exploitability given usage patterns, but technical debt that compounds the longer it's deferred.
6. **Unconfirmed infrastructure items** (Atlas IP allowlist scoping, backup/restore drill, TLS termination) — not code risk, but block a truthful "production ready" claim regardless of code quality.
7. **SEC-005/SEC-006 — latent/low-severity gaps** (unused weaker ownership-scoping helper, unrated refresh-token endpoint) — low urgency, cheap to fix, worth doing during the same pass as SEC-001.

---

## 17. Critical Production Blockers

These must be resolved before real user data (real student phone numbers, real KYC documents, real owner accounts) flows through this system in production:

1. **SEC-001**: OTP code leakage in the `request-otp` response. This alone makes the entire student-facing authentication system provide no real security today.
2. **SEC-002**: Super-Admin MFA — already flagged as a pre-launch item by the prior hardening report; this audit concurs it belongs on the blocker list given the account's blast radius, not just the "nice to have" backlog.
3. **Live infrastructure confirmation** (not code): MongoDB Atlas IP allowlist restricted to the production server's actual IP (currently "allow from anywhere" per the hardening report, for dev convenience), a confirmed-successful backup **restore** test (not just "backups are enabled"), and TLS/HTTPS termination confirmed at the hosting layer. None of these are verifiable from source code and none were verifiable from this sandbox — they must be confirmed by the project owner directly against the real infrastructure before launch.

---

## 18. Improvement Backlog

| Priority | Issue | Reason | Estimated Risk | Recommended Action (documentation only — not implemented in this audit) |
|---|---|---|---|---|
| P0 | SEC-001: OTP leaked in API response | Complete auth bypass | Critical | Remove `_dev_code` from the production response path; gate any dev-convenience field behind an explicit non-`NODE_ENV`-alone flag |
| P0 | SEC-002: No Super-Admin MFA | Full-platform blast radius on single factor | High | Implement TOTP MFA for `super-admin` role before launch |
| P1 | DB-001: No explicit connection pool config | CLAUDE.md 4.3 violation; silent degradation risk at scale | Medium | Add explicit `maxPoolSize`/`minPoolSize`/`serverSelectionTimeoutMS` to `mongoose.connect()` |
| P1 | SEC-004: In-memory rate limiter | Ineffective once horizontally scaled | Medium | Migrate to Redis-backed store (`@upstash/redis` already a dependency) before multi-instance deployment |
| P2 | SEC-003: `node-cron`/`langchain` dependency vulnerabilities | Real CVEs, low current exploitability | Medium (compounds over time) | Schedule a dedicated, tested upgrade pass for `node-cron`; defer `langchain` upgrade until the module is actually mounted |
| P2 | Missing restore-from-backup drill | Can't claim disaster-recovery readiness without proof | Medium | Perform and document a real Atlas restore test |
| P3 | SEC-005: Unused, weaker `ownershipScopingMiddleware` | Latent trap for future developers | Low | Delete or clearly comment as deprecated/do-not-use |
| P3 | SEC-006: `refresh-token` endpoint has no rate limiter | Consistency gap vs. CLAUDE.md 3.7 | Low | Add a generous limiter for defense-in-depth |
| P3 | `owners`/`messages`/`ai-assistant` modules unmounted with no indexes, not hardened | Latent risk if mounted later without re-review | Low today | Track explicitly (ticket or prominent code comment); re-run the ownership/mass-assignment/index checklist before ever mounting any of them |
| P4 | No load-testing tooling in the repo | Can't characterize real throughput before launch | Low today, higher pre-launch | Add a basic k6/Artillery script and run it against a staging deployment before the first real term-start peak |

---

## 19. Final Risk Matrix

| Severity | Count | Items |
|---|---|---|
| **Critical** | 1 | SEC-001 (OTP leaked in API response) |
| **High** | 2 | SEC-002 (no Super-Admin MFA), SEC-003's high-severity component (`langsmith` SSRF/prototype-pollution, dormant module) |
| **Medium** | 3 | DB-001 (no connection pooling), SEC-004 (in-memory rate limiter), SEC-003's moderate components (9 pkgs, includes the live `node-cron`) |
| **Low** | 2 | SEC-005 (unused weaker ownership helper), SEC-006 (unrated refresh-token endpoint) |
| **Informational** | 3 | SEC-007 (CORS allowlist empty — safe-by-default), unmounted-module inventory (Section 11 item 2), infrastructure items not verifiable from code (Atlas allowlist/backup-restore/TLS) |

---

## 20. Production Readiness Score

Overall: **62 / 100** — solid, disciplined engineering foundation, held back specifically by one critical authentication defect and a handful of already-known, already-documented deferred items. The score would be materially higher (high 70s/low 80s) the moment SEC-001 alone is fixed — it is disproportionately responsible for the low overall number given how sound the rest of the system is.

| Category | Score /100 | Rationale |
|---|---|---|
| Security | 45 | Dragged down heavily by SEC-001 (critical, previously undocumented) despite otherwise strong hardening (JWT pinning, CORS, mass-assignment whitelisting, EXIF stripping, magic-byte upload validation all independently re-confirmed sound) |
| Scalability | 65 | Pagination, batching, and aggregation patterns are all correct for the ~500K-student target; connection pooling (DB-001) and in-memory rate limiting (SEC-004) are the two concrete gaps standing between "correct today" and "correct at real target scale" |
| Performance | 70 | No measured data (honesty requirement — nothing here is a real benchmark), but every structural pattern reviewed (indexes, batching, aggregation, no N+1) is sound; DB-001 is the one clear, identifiable risk |
| Reliability | 75 | Graceful shutdown, per-job fault isolation, and idempotent background jobs are all correctly implemented; the missing `serverSelectionTimeoutMS` (tied to DB-001) is the main gap |
| Maintainability | 80 | Consistent modular-monolith discipline, extensive and honest in-code documentation of technical decisions and their reasoning, no direct cross-module model access found anywhere reviewed |
| Architecture | 78 | Sound module boundaries and deliberate circular-dependency avoidance; the only real ding is the unmounted-module inventory item (Section 11) and the pre-emptive `langchain` dependency cost for a not-yet-built feature |
| Code Quality | 80 | Clean, well-commented, consistent patterns; SEC-005 (dead weaker-pattern code) is the only concrete quality ding found |
| Database | 68 | Excellent indexing and query-pattern discipline; DB-001 (no explicit pooling) is a direct, unambiguous CLAUDE.md violation and the main deduction |
| APIs | 72 | Consistent response shape and error handling across the board; SEC-001 and SEC-006 are both fundamentally API-response-shape issues |
| Business Logic | 82 | The two mechanics that matter most (atomic bed lock, atomic payment confirm) are both implemented correctly and were independently re-verified by code tracing in this audit, not just trusted from prior claims |

---

## Methodology Note (for the record)

This audit deliberately re-derived findings from the current source rather than summarizing prior reports. Where this audit's conclusion matches a prior report, that is stated as "re-confirmed" with the specific check performed. Where it found something new (SEC-001, DB-001, SEC-005, the precise `fastdl.mongodb.org` diagnosis replacing the older generic "network-restricted sandbox" note), that is stated explicitly as new. No performance or load-testing number anywhere in this report is fabricated — every such section is explicitly labeled as a code-based assessment, per the audit brief's Honesty Requirement. No fix was implemented for any finding in this report, per the audit's mission boundary; a separate remediation prompt is expected to follow.
