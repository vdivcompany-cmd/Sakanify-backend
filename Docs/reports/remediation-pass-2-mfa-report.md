# Remediation Pass 2 — Super-Admin MFA (SEC-002) — Report

Based on `remediation-pass-2-mfa.md` (fix-authorized implementation of SEC-002 — mandatory Super-Admin TOTP MFA), following `Docs/reports/ENTERPRISE_BACKEND_AUDIT_REPORT.md` and `Docs/reports/remediation-pass-1-report.md`.

**Language note:** written in English, same reasoning as `remediation-pass-1-report.md` — this is a fix-authorized technical engineering deliverable with an explicit English source spec (`remediation-pass-2-mfa.md`), not a numbered phase's stakeholder-facing report under `CLAUDE.md` Section 1.

**Date:** 2026-08-02

**Status: code-complete, statically verified, and unit-tested where the sandbox allows. The CI-breaking otplib/Jest ESM defect reported after this pass's first push has been root-caused and fixed — see "CI-Investigation Follow-Up" below. NOT YET re-verified by a real GitHub Actions run since that fix. Do not treat this as fully confirmed until a real CI run's exact pass/fail counts (all 15 suites, not just the 4 that passed before) are pasted back in, per the standing project rule.**

## Scope (as authorized)

Implemented in this pass: **SEC-002** — mandatory TOTP-based MFA for every Super-Admin account, per the 6 product decisions and 10 implementation steps in `remediation-pass-2-mfa.md`.

Explicitly NOT touched in this pass, matching the spec: MFA for Owner/Student roles (out of scope — Super-Admin only), SEC-004 (Redis-backed rate limiter), SEC-003 (dependency CVEs), any infrastructure item.

---

## What Was Built

### 1. Dependency and configuration

- **`package.json` / `package-lock.json`** — added `otplib@^13.4.1` (9 packages added via `npm install`, no new vulnerabilities introduced; dependency audit total unchanged at 1 high / 9 moderate, all pre-existing and out of this pass's scope).
- **`src/config/env.config.js`** — added `MFA_ENCRYPTION_KEY` to `REQUIRED_VARS` (fail-fast boot per `CLAUDE.md` Section 9), with explicit format validation (`/^[0-9a-fA-F]{64}$/`) so a malformed key is caught at startup, not at the first encrypt/decrypt call in production. Added `env.mfa = { encryptionKey, totpWindowSeconds: 30, setupTokenExpiry: '10m', pendingTokenExpiry: '10m' }`.
- **`.env.example`** — documented the new variable with a one-line generation command (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), no real value committed.
- **`.env`** (local, gitignored, not committed) — a local-dev-only 64-hex key was added so the app can still boot locally; noted here only because `.env` previously had no entry for it at all and would otherwise fail-fast on any local run, not because its contents matter for this report.
- **`.github/workflows/backend-tests.yml`** — added a dummy 64-hex `MFA_ENCRYPTION_KEY` to **both** env blocks that boot the app (the "Run test suite" step and the "Run health-check smoke test" step) — this took two separate edits since the first `replace_all` only matched one of the two occurrences (different surrounding YAML). Re-read the file after the first edit and caught the gap before it could have failed CI.

### 2. Data model (`src/modules/auth/auth.model.js`)

Four new fields on the `User` schema, all defaulting to the "not enrolled" state:
- `mfa_enabled: Boolean` (default `false`)
- `mfa_secret_encrypted: String` (default `null`, `select: false` — never returned by a plain `find`/`findById`, must be explicitly selected)
- `mfa_enrolled_at: Date` (default `null`)
- `backup_codes: [{ code_hash: String (required), used_at: Date (default null) }]` (`_id: false` on the subdocument, default `[]`, `select: false`)

### 3. `src/modules/auth/mfa.service.js` (new)

Owns every piece of MFA-specific business logic that isn't HTTP or routing:
- **AES-256-GCM encrypt/decrypt** for the TOTP secret at rest (`encryptSecret`/`decryptSecret`). A 12-byte random IV and the GCM auth tag are concatenated with the ciphertext into a single self-contained base64 string, so no separate IV/tag column has to be kept in sync. Decrypting a tampered value throws (GCM's built-in integrity check) rather than silently returning garbage.
- **`generateEnrollment(email)`** — generates a fresh TOTP secret + `otpauth://` URI (for QR rendering, a frontend concern) + 10 backup codes (`crypto.randomBytes(5).toString('hex').toUpperCase()`, 40 bits of entropy each) and their bcrypt hashes. Writes nothing to the database — see the "pending enrollment" design decision below.
- **`verifyTotpCode(secret, token)`** — wraps `otplib`'s `verify()` with a 30-second `epochTolerance` (clock-drift allowance) and catches its throw-on-malformed-token behavior, returning `false` instead of letting a bad request 500.
- **`findMatchingUnusedBackupCode(user, plainCode)`** — sequential, oldest-first `bcrypt.compare` loop that skips already-used entries and short-circuits on the first match (deliberately sequential, not `Promise.all`, since bcrypt's slowness is the point and 10 parallel compares would be wasted work once one matches).
- **`persistConfirmedEnrollment`** — the **only** function in the codebase that writes `mfa_enabled: true` to the database. Called exactly once, from `mfa.controller.verifySetup`, only after a real 6-digit code has been verified against the pending secret.
- **`markBackupCodeUsed`** — marks a single backup-code subdocument used; the caller controls the surrounding `save()` so this stays a pure mutation with no independent DB round-trip.

### 4. `src/modules/auth/auth.service.js` (modified)

- Two scoped, narrow-purpose JWT types: `mfa_setup` and `mfa_pending`, both signed with the same `accessSecret` as a real access token (so they flow through the existing `jwt.verify` call in `authService.verifyToken`) but carrying a `type` claim that must be explicitly checked by anything that accepts them.
- `issueMfaSetupToken(userId, pendingSecretEncrypted, pendingBackupCodeHashes)` — the enriched version (called by `mfa.controller.setup`) embeds the pending secret/hashes as claims; the bare version (issued by `loginOwner`) carries neither, and `mfa.controller.verifySetup` explicitly rejects a bare token with a "call /setup first" 400 rather than silently doing nothing.
- `issueMfaPendingToken(userId)` — issued by `loginOwner` when `mfa_enabled` is already `true`.
- `verifyScopedMfaToken(token, expectedType)` — verifies signature/algorithm and the exact `type` claim in one call.
- `resetMfaForUser(userId)` — clears all four MFA fields back to their pre-enrollment defaults. Deliberately does **not** audit-log itself (matching the existing `setUserStatus` pattern) — that's the caller's responsibility, so the activity feed shows one admin-attributed event per operation, not two.
- **`loginOwner()` branch (Super-Admin only; Owner path is completely unmodified):**
  - `mfa_enabled: false` → returns `{ success, userId, role, ownerId, mfaSetupRequired: true, setupToken }` — no real tokens.
  - `mfa_enabled: true` → returns `{ success, userId, role, ownerId, mfaVerificationRequired: true, pendingToken }` — no real tokens.
  - Real access/refresh tokens are issued **only** by `mfa.controller.verifySetup` (first-time enrollment) or `mfa.controller.verifyLogin` (subsequent logins).

### 5. `src/middleware/auth.middleware.js` (modified — includes a real security fix found during this pass)

- **`verifyToken()` hardening (the fix):** before this pass, the normal (non-impersonation) code path only checked `decoded.type === 'impersonation'` as a special case and otherwise accepted anything signed with `accessSecret` as a full session. That was harmless before this pass because no other token type was ever signed with `accessSecret` (refresh tokens use a separate secret). It stopped being harmless the moment `mfa_setup`/`mfa_pending` tokens were introduced, signed with the same `accessSecret` — without a fix, either scoped token could have been used to reach **any** protected endpoint in the entire API, not just the `/mfa/*` routes it was actually issued for. Fixed by adding an explicit `if (decoded.type !== 'access') { return 401 }` check right before the user lookup. Found and fixed proactively while wiring the new middlewares below, not reported by anyone else.
- **`verifyMfaSetupAccess`** (new) — authorizes `POST /api/auth/mfa/setup` and `/verify-setup`. Accepts exactly two token shapes: a real `access`-type token for a Super-Admin (with the normal liveness checks — account active, not invalidated since issue), or a bare/enriched `mfa_setup` token (no liveness check — it's a one-shot action token, not a session). Any other type (`mfa_pending`, `refresh`) is rejected.
- **`verifyMfaPendingAccess`** (new) — authorizes `POST /api/auth/mfa/verify-login`. Strictly requires an `mfa_pending` token; a real `access` token is deliberately **not** accepted (no legitimate reason to "verify login" for a session that already exists).

### 6. `src/modules/auth/mfa.controller.js` + `mfa.routes.js` (new)

Three endpoints, all under `/api/auth/mfa`, every catch block routed through the shared `normalizeError()`/`AppError` classifier per `CLAUDE.md` Section 7.3a:

| Route | Auth | Purpose |
|---|---|---|
| `POST /setup` | `verifyMfaSetupAccess` | Generates a fresh secret + otpauth URI + 10 backup codes; returns an enriched `mfa_setup` token carrying the pending (encrypted) secret and (hashed) backup codes. Nothing written to the DB yet. |
| `POST /verify-setup` | `verifyMfaSetupAccess` + must carry pending claims | Verifies a real 6-digit code against the pending secret; on success, calls `persistConfirmedEnrollment`, audit-logs `mfa_enrolled`, and issues real access/refresh tokens immediately. |
| `POST /verify-login` | `verifyMfaPendingAccess` | Accepts `{ code }` or `{ backup_code }`; on success issues real tokens. A used backup code is marked used and audit-logged as the distinct action `mfa_backup_code_used` (a weaker signal than a live TOTP code, deliberately visible as its own searchable entry in the Phase 7 activity feed). |

Rate limiting (own `MemoryStore` per limiter, same pattern as `auth.routes.js`, test-resettable via `.resetAll()`):
- `setup`: 10 requests / 15 min (generous — already requires a valid setup/access token, i.e. a correct password was required upstream).
- `verify-setup` and `verify-login`: 5 requests / 5 min each — aggressive, same risk profile as a brute-forceable 6-digit OTP path.

`mfa.routes.js` is mounted in `src/app.entry.js` as `app.use('/api/auth/mfa', require('./modules/auth/mfa.routes'))`, right after the existing `/api/auth` mount.

### 7. `src/modules/admin/admin.service.js` + `admin.controller.js` + `admin.routes.js` (modified — implementation step 8)

New endpoint: `POST /api/admin/super-admins/:id/reset-mfa`, mounted behind the module's existing `router.use(verifyToken, requireRole(SUPER_ADMIN))`. `adminService.resetSuperAdminMfa(targetUserId, actorUserId)`:
1. Rejects `targetUserId === actorUserId` with a `403` — a Super-Admin cannot reset their own MFA through this admin-assisted path (if genuinely locked out, that requires a second admin).
2. Confirms the target exists and has `role === SUPER_ADMIN`, otherwise `404`/`422`.
3. Calls `authService.resetMfaForUser(targetUserId)`, then writes the single audit-log entry (`mfa_reset_by_admin`, actor + target both recorded) — the one audit entry for the whole operation, matching the pattern established by `suspendOwner`/`reactivateOwner` in this same module.

### 8. `scripts/seed-super-admin.js` (modified)

No functional change was needed — the schema's own defaults already give a freshly-seeded account `mfa_enabled: false`, which correctly routes it into the mandatory-setup branch on first login. Updated only the script's stale closing message, which predated this pass and said "Enable 2FA when available (future phase)" — now says MFA is mandatory and that the first login returns a setup token, not a session.

---

## Key Technical Decisions

1. **Stateless "pending enrollment" design.** The freshly-generated TOTP secret and backup-code hashes are embedded (encrypted/hashed, never plaintext) as claims inside the short-lived `mfa_setup` token returned by `POST /setup`, rather than written to a new "pending" field on the `User` document. This satisfies the spec's requirement that nothing persists until a real code is confirmed, without adding schema surface area for a state that's supposed to be transient. Trade-off: if the admin loses that specific token before confirming, they simply call `/setup` again — no cleanup needed, since nothing was ever written.
2. **Both scoped token types reuse `accessSecret`.** This was necessary for them to flow through the existing `authService.verifyToken(token, 'access')` call inside the new middlewares, but it's exactly what made the `verifyToken()` type-check hardening (Section 5 above) load-bearing rather than optional — documented as a technical decision because the spec did not explicitly call out this specific interaction.
3. **Backup codes are hashed (bcrypt), not encrypted.** Per the spec's own reasoning: they're single-use and never displayed again after generation, so there's no legitimate reason to ever recover the plaintext — a one-way hash is the correct primitive, matching `password_hash`'s existing standard.
4. **Admin-assisted reset explicitly forbids self-reset.** Not explicitly required by the six product decisions in the spec but a clear extension of "mandatory MFA" — a self-service reset endpoint would let any Super-Admin trivially defeat the entire feature. Flagged here per `CLAUDE.md` Section 7.4/7.5 as a decision made during implementation, not literally specified.

## Deviations From The Original Spec

None identified. Every one of the 10 implementation steps and 6 product decisions in `remediation-pass-2-mfa.md` was implemented as written; the only genuinely new thing not explicitly named by the spec is the `verifyToken()` type-check hardening, which is a defensive fix made necessary by the spec's own design (scoped tokens sharing `accessSecret`), not a deviation from it.

---

## Verification Performed

### Static / syntax

Every new or modified file passed `node --check` individually: `env.config.js`, `auth.model.js`, `mfa.service.js`, `auth.service.js`, `auth.middleware.js`, `mfa.controller.js`, `mfa.routes.js`, `auth.controller.js`, `app.entry.js`, `admin.service.js`, `admin.controller.js`, `admin.routes.js`, `scripts/seed-super-admin.js`, `tests/integration/mfa.test.js`, `tests/unit/mfa.service.test.js`.

### Full application boot

`require('./src/app.entry.js')` was executed directly (not via jest) with all MFA code wired in, timed end-to-end: **completed successfully in ~37 seconds**, requiring every module in the app including the two new files (`auth.routes` → 2.5s, `mfa.routes` → ~1s on top of that, both fast and error-free) with zero circular-dependency or require-time errors. The ~37s total is consistent with this sandbox's previously-documented slow cold I/O on the mounted project drive (see `project_sakanify_sandbox_network.md`) — the individual per-module timings confirm it is pure I/O latency (`database.config` alone, which pulls in mongoose, accounted for ~24s of the total), not a hang or bug. This directly answers the one open question carried into this session: the earlier 45-second tool-call timeouts on this exact boot check were a sandbox timing artifact, not a defect in the MFA wiring.

### Unit tests — genuine executed evidence

A new pure-logic unit test file, `tests/unit/mfa.service.test.js` (17 test cases: encrypt/decrypt round-trip, tamper-rejection, enrollment shape, real-TOTP-code verification via `otplib`'s own `generate()`, wrong/malformed-code rejection, backup-code matching/exclusion), was written to jest conventions and syntax-checked, but **jest itself could not complete within this sandbox's tool-call time cap for any test file that requires `auth.model.js` (mongoose)** — this includes the two pre-existing mongoose-touching unit suites (`auth-jwt-algorithm.test.js`, `database.config.pool.test.js`) as well as the new `mfa.service.test.js`, all of which timed out repeatedly even after cache-warming attempts. This is a **new, previously undocumented layer** on top of the known slow-mounted-drive-I/O constraint: jest's own per-file bootstrap/transform overhead, stacked on the ~35s+ mongoose cold-require cost, pushes total time past the sandbox's 45-second tool-call limit even where the underlying code is correct. By contrast, the one pre-existing unit suite that does **not** touch mongoose (`metadata-strip.util.test.js`) ran via real jest in 7.4 seconds with all 8 tests passing, confirming jest itself is not the bottleneck in general — only the combination of jest + a fresh mongoose require is.

To avoid reporting "the code runs" as "it's tested" (the exact gap `CLAUDE.md` Section 6.1 exists to prevent), the same nine core assertions from `mfa.service.test.js` were additionally executed directly via a standalone Node script (bypassing jest's overhead, using the real `mfa.service.js`, `otplib`, and `bcryptjs` — no mocks) as a substitute for the jest run that could not complete in time. **Result: 9/9 passed**, covering encrypt/decrypt round-trip, tamper rejection, enrollment shape (10 unique backup codes, valid otpauth URI), real-TOTP-code verification (a genuine code generated by `otplib.generate()` against the real secret was independently verified as valid), wrong/malformed-code rejection without throwing, and all three backup-code-matching branches (valid, already-used, never-issued). This is real, directly-executed evidence for the new crypto/TOTP/backup-code logic — not a claim based on code-reading alone.

### Integration tests — cannot execute in this sandbox (pre-existing, re-confirmed limitation)

`tests/integration/mfa.test.js` (22 test cases covering the full HTTP-level enrollment flow, login-before/after-enrollment, backup-code single-use enforcement end-to-end, admin-assisted reset by a different Super-Admin, self-reset rejection, non-Super-Admin-target rejection, rate limiting on both verify endpoints, and the negative case that a setup/pending token cannot reach a real protected endpoint) was written and syntax-checked, but **could not be executed** — `mongodb-memory-server` requires downloading a MongoDB binary from `fastdl.mongodb.org`, which remains blocked by this sandbox's network allowlist, exactly as documented for every prior remediation pass and the original audit. Every assertion in this file was manually traced against the real controller/service/middleware code (request/response shapes, status codes, DB field names, audit action names) rather than guessed, but this is **code-reading verification, not execution evidence**, and must not be conflated with the unit-test results above.

**Full Phase 1 auth regression check:** `authService.loginOwner()`'s Owner branch is unchanged (verified by direct code reading — the new `if (user.role === ROLES.SUPER_ADMIN)` branch wraps only the Super-Admin path; the pre-existing Owner `return` is untouched). A project-wide search confirmed no existing test calls the real `POST /api/auth/login-owner` HTTP endpoint for a `SUPER_ADMIN` role — every existing test that needs a Super-Admin session bypasses login entirely via a direct `authService.issueTokens()` call, which already produces a correctly-`type`-stamped `access` token unaffected by any change in this pass. This establishes zero regression risk to existing tests from the `loginOwner()` MFA-gating change, but — consistent with the honesty standard the project owner has held every prior pass to — this is a structural/code-reading argument, not a re-run of the actual suite (which cannot execute here for the same `mongodb-memory-server` reason).

---

## Known Sandbox Artifacts (not part of the codebase)

Two throwaway diagnostic scripts were created directly on the mounted drive during boot/logic verification (`_boot_diag_tmp.js`, `_mfa_manual_check_tmp.js`) and could **not** be deleted afterward — `rm` fails with `Operation not permitted`, the same recurring mounted-drive permission quirk documented in a prior pass for a stale `mongodb-memory-server` cache file. Both are untracked (`git status` confirms), have zero references from any real module, and must be deleted manually by the project owner before running `push.bat`, or explicitly excluded if `push.bat` does a broad `git add .`.

---

---

## CI-Investigation Follow-Up — otplib/Jest ESM SyntaxError (2026-08-02)

### The report from real CI

After the first push of this pass, the real GitHub Actions run showed **11 of 15 suites failing** with, verbatim from the raw CI log:

```
node_modules/@scure/base/index.js:366
SyntaxError: Unexpected token 'export'
```

The 4 passing suites were exactly the ones that never boot the full app (`app.entry.js`); every suite that does (any suite requiring `app.entry.js` → `auth.routes` → `mfa.routes` → `mfa.controller` → `mfa.service` → `otplib`) failed at require-time.

### Root cause (confirmed, not guessed)

The top-level `otplib` package — and its `otplib/functional` and `otplib/class` sub-paths — **unconditionally `require()` their default crypto/base32 plugins at module-load time**, regardless of whether the caller ever uses those defaults. Confirmed directly by reading `node_modules/otplib/dist/functional.cjs`: the very first lines execute `require("@otplib/plugin-base32-scure")` and `require("@otplib/plugin-crypto-noble")` unconditionally. Those two plugins pull in `@scure/base` and `@noble/hashes` respectively — both ship as **pure ESM with no CJS build** (confirmed via `node_modules/@scure/base/package.json`: only `index.js`, no `.cjs` file, no `require` export condition). Jest's default configuration does not transform `node_modules`, so `require('otplib')` alone — even with the code passing its own `crypto`/`base32` options everywhere it's called — crashes under Jest with `SyntaxError: Unexpected token 'export'` the instant `otplib` is required, before any of `mfa.service.js`'s own code runs.

This was invisible in every check performed during the original implementation (`node --check` syntax validation, direct-`node` app boot, direct-`node` execution of the MFA logic) because **plain Node's CommonJS loader resolves the `otplib` package's `require` export condition to `functional.cjs`, and `.cjs` itself loads fine under plain Node** — the crash is specific to Jest's stricter (untransformed-`node_modules`) module loading, not to Node itself. This is why static checks and direct-`node` verification passed cleanly in this sandbox while the real CI's Jest run failed — a gap between "runs under plain Node" and "runs under Jest" that only a real Jest run could have caught, and this sandbox could never run a full Jest suite against a mongoose-touching file within its tool-call time limit (see "Verification Performed" above) to catch it before the first push.

### Fix chosen: Option 1 (Node-native import path), not a Jest config workaround

Per the investigation's stated preference order, a documented Node-specific preset was located and used, **not** a `transformIgnorePatterns`/babel-jest workaround:

- `@otplib/core`, `@otplib/totp`, `@otplib/uri` — confirmed via `npm view <pkg> dependencies` to have **zero external dependencies** (they only depend on each other).
- `@otplib/plugin-crypto-node` — Node's built-in `crypto` module, confirmed zero external dependencies.
- For Base32 encoding, `@otplib/plugin-base32-alt` (the other documented Node-oriented option) was evaluated and **rejected**: its `bypassAsString`/`bypassAsHex`/`bypassAsBase64` variants do not perform real Base32 encoding at all — they're pass-through bypasses. Using one would have produced a `secret` in the `otpauth://` URI that is **not valid Base32**, which would silently break compatibility with every real authenticator app (Google Authenticator, Authy, 1Password, etc.) while still passing every internal test, since nothing in this codebase's test suite scans a QR code with a real app. This was caught by reading `@otplib/plugin-base32-alt`'s own type definitions before using it, not discovered later.
- Instead, `mfa.service.js` now includes a small (~35 line), dependency-free, standard RFC 4648 Base32 encoder/decoder (unpadded, matching Google Authenticator's convention), wrapped via `@otplib/core`'s own `createBase32Plugin({ encode, decode })` factory. This is a real, spec-compliant Base32 codec — not a bypass — so QR/manual-entry compatibility with real authenticator apps is preserved.

**Net result:** `mfa.service.js` no longer imports `otplib` (or `otplib/functional`/`otplib/class`) anywhere. It imports `@otplib/core`, `@otplib/totp`, `@otplib/uri`, and `@otplib/plugin-crypto-node` directly, passing the custom RFC 4648 plugin and the Node crypto plugin explicitly to every call (`generateSecret`, `generate`, `verify`). Confirmed via `ls node_modules/@scure` (empty — the package is gone entirely) that zero ESM-only packages remain anywhere in this require chain. The `otplib` package itself was uninstalled (`npm uninstall otplib`); `package.json` now lists `@otplib/core`, `@otplib/totp`, `@otplib/uri`, and `@otplib/plugin-crypto-node` as direct dependencies instead, matching the code's actual require graph.

**Files changed in this follow-up:**
- `src/modules/auth/mfa.service.js` — replaced the `otplib` import with the four direct `@otplib/*` imports; added `rfc4648Base32Encode`/`rfc4648Base32Decode` + `rfc4648Base32Plugin`; updated `generateEnrollment` and `verifyTotpCode` to pass `crypto: nodeCryptoPlugin, base32: rfc4648Base32Plugin` explicitly; added a new test-only exported accessor, `__generateTotpCodeForTesting(secret)` (same naming/guard convention as `otp.service.js`'s pre-existing `__getLastOtpForPhone`), so tests can generate a real, currently-valid code without ever importing `otplib` themselves.
- `tests/integration/mfa.test.js`, `tests/unit/mfa.service.test.js` — replaced `require('otplib').generate` with `mfaService.__generateTotpCodeForTesting`, and updated the two call sites in each file from the object-argument form (`generateTotp({ secret })`) to the new single-argument form (`generateTotp(secret)`).
- `package.json` / `package-lock.json` — removed `otplib`; added `@otplib/core`, `@otplib/totp`, `@otplib/uri`, `@otplib/plugin-crypto-node` as direct dependencies (all already transitively present at the same `13.4.1` version, now made explicit). `@otplib/plugin-base32-alt` was installed during the investigation, evaluated, rejected for the reason above, and uninstalled again — it is not a dependency of the final code.

**MFA logic itself was not touched**, per the investigation's explicit instruction — `encryptSecret`/`decryptSecret` (AES-256-GCM), `hashBackupCodes`/`findMatchingUnusedBackupCode` (bcrypt), `persistConfirmedEnrollment`, `markBackupCodeUsed`, and every controller/route/middleware file are byte-for-byte unchanged from the original implementation described earlier in this report. Only the TOTP-secret-generation and TOTP-verification primitives' import path changed.

### Verification performed for this follow-up

- `node --check` on all three changed files: pass.
- `ls node_modules/@scure`: empty — confirms the ESM-only package is genuinely gone from the dependency tree, not just unused-but-present.
- Full application boot (`require('./src/app.entry.js')`, the same require graph Jest would need to load, executed directly via `node`, not jest): **completed successfully in ~39 seconds**, zero errors, including the full `mfa.routes` → `mfa.controller` → `mfa.service` → `@otplib/*` chain. This is the load-bearing check: it proves the SyntaxError's underlying cause (an ESM package in the require graph) is gone, since a `SyntaxError: Unexpected token 'export'` would fail identically under plain Node if the offending package were still anywhere in the chain — it did not fail.
- Direct-`node` re-execution (not jest, for the same tool-call-time reasons documented earlier in this report) of the updated MFA logic: **13/13 real assertions passed** across two verification scripts — a valid RFC 4648 Base32 secret is produced (`/^[A-Z2-7]+$/`), a real TOTP code generated via the new `@otplib/totp` + Node-crypto + custom-Base32 chain is independently verified as valid by `verifyTotpCode`, a wrong code is correctly rejected, and the same valid code verifies successfully on a second check (confirming standard non-single-use TOTP behavior, as expected — single-use enforcement applies only to backup codes, not TOTP codes).
- **Jest itself still could not complete within this sandbox's 45-second tool-call cap** for `tests/unit/mfa.service.test.js`, even after this fix — repeated attempts timed out with no output captured. This is consistent with, and does not change, the pre-existing constraint already documented earlier in this report (jest's own per-file bootstrap overhead stacked on mongoose's ~35s+ cold-require cost on this sandbox's mounted drive) — it is unrelated to the ESM defect just fixed, which was a *require-time crash*, not a *slow require*. The app-boot check above is the strongest evidence available from within this sandbox that the crash itself is gone; confirming jest's exact `Tests: X passed, Y total` output requires the real CI run, same as every other suite in this project.

### What was NOT re-verified from within this sandbox

The exact `Test Suites: 15 passed, 15 total` / `Tests: N passed, N total` line requested in the investigation — this sandbox cannot run a full Jest suite against any mongoose-touching file within its tool-call time limit, a constraint that predates and is independent of this specific fix (see "Verification Performed" earlier in this report, and prior remediation passes' reports for the same documented limitation). This must come from a real GitHub Actions run.

---

## Known Sandbox Artifacts (updated)

Two additional throwaway diagnostic scripts were created during this follow-up investigation (`_boot_diag2_tmp.js`, `_mfa_manual_check2_tmp.js`), on top of the two from the original pass (`_boot_diag_tmp.js`, `_mfa_manual_check_tmp.js`) — all four could not be deleted (`rm` fails with `Operation not permitted`, the same recurring mounted-drive permission quirk). All four are untracked (confirmed via `git status`), have zero references from any real module, and must be deleted manually before committing.

**Also observed during this follow-up:** a stale, empty `.git/index.lock` file is present on this mounted drive (`ls -la .git/index.lock` confirms it exists, 0 bytes). Claude Desktop did not run any `git add`/`commit`/`push` command that could have created it — it appears to be a pre-existing artifact on this mounted drive, surfaced by a plain read-only `git status` call attempting (and failing, same permission quirk) to refresh it. `CLAUDE.md` Section 11.4 already documents that `push.bat` handles stale `index.lock` cleanup automatically, so this is flagged here only as an FYI, not expected to block the next push.

## What Still Needs To Happen

1. **Project owner deletes the four stray temp files** noted above (or confirms they're excluded from the commit) — `_boot_diag_tmp.js`, `_mfa_manual_check_tmp.js`, `_boot_diag2_tmp.js`, `_mfa_manual_check2_tmp.js`.
2. **Project owner runs `push.bat`** — no git command was run by Claude Desktop in this pass or this follow-up, per `CLAUDE.md` Section 11.
3. **Real GitHub Actions confirmation required** before this pass is "fully verified," per the standing project rule and the precise-honesty standard set in Session 2 of this project: the exact `Test Suites: 15 passed, 15 total` / `Tests: N passed, N total` line from the real CI run, covering every suite (existing + the two new MFA files), not just an overall green checkmark. This is the specific confirmation still outstanding — the previous CI run's 11-suite failure is what triggered this follow-up, and that failure has not yet been re-tested by a real CI run since the fix.
4. Until that confirmation is provided, this report's status remains **code-complete, root-cause fixed, and directly-executed-verified where the sandbox allows — not yet CI-confirmed.**

## Final Status

**Code-complete, including the CI-investigation follow-up.** All 10 implementation steps and 6 product decisions from `remediation-pass-2-mfa.md` are implemented, statically verified, and (where the sandbox allows) directly executed with passing results. The otplib/Jest ESM `SyntaxError` reported from the first real CI run has been root-caused (an ESM-only transitive dependency of `otplib`'s default plugins, unconditionally required at module-load time) and fixed at the source (switched to the documented Node-native `@otplib/*` building blocks plus a hand-rolled, spec-compliant Base32 codec — not a Jest configuration workaround), with the MFA logic itself untouched. Full-suite jest-level and integration-level verification for the mongoose-touching suites remain blocked by pre-existing, documented sandbox constraints (network-blocked `mongodb-memory-server` binary download; slow mounted-drive I/O exceeding the tool-call time cap when combined with jest's own overhead) — not by any known defect in the implementation. Awaiting a real GitHub Actions run to confirm all 15 suites pass before this pass can be marked fully verified.
