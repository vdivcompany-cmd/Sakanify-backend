# Phase 1 — Authentication & Role-Based Access

## Goal
Enable secure login/logout for all three roles (Student, Owner, Super-Admin), each with distinct, isolated access.

## Context
Students authenticate via phone + OTP (no password). Owners and Super-Admins authenticate via email/password. Role isolation and ownership-scoping (an owner only ever accessing their own data) are established here and used by every later module.

## Folders & Files to Create This Phase

```
src/modules/auth/
├── auth.routes           → Endpoints: register, login, refresh token, logout, password reset (owner/admin), request-OTP, verify-OTP (student)
├── auth.controller        → Handles incoming requests, calls auth.service
├── auth.service            → Core auth logic: token issuing, credential checks, session handling
├── auth.middleware          → Role-guard middleware used by every other module going forward (student-only / owner-only / super-admin-only / shared)
└── otp.service              → OTP generation, expiry, verification, rate-limiting for student phone login
```

*(Ownership-scoping logic — e.g., "owner can only access their own buildings" — is implemented as a reusable pattern inside `auth.middleware` or a shared helper it exposes, since every later module will call into it.)*

## Implementation Steps

1. Decide and document the auth data model approach: one unified auth collection with a `role` field, or separate collections per role linked to a shared identity.
2. Build `otp.service`: generate OTP, send it (placeholder for actual SMS provider), verify it, expire it after a defined window, rate-limit repeated requests.
3. Build the student login flow in `auth.service`/`auth.controller`: request OTP → verify OTP → issue tokens.
4. Build the owner/super-admin login flow: email + password, with proper password hashing (e.g., bcrypt) — never store plaintext passwords.
5. Implement JWT access + refresh token issuing and validation in `auth.service`.
6. Build `auth.middleware` role-guard functions that every future module's routes will use to restrict access by role.
7. Build the ownership-scoping helper (e.g., a function/middleware that checks a requested resource belongs to the authenticated owner) — document this clearly since every owner-facing module from Phase 3 onward depends on it.
8. Build logout/session invalidation.
9. Build password reset flow for owners/super-admins (email-based).
10. Write tests confirming: a student token cannot hit owner-only routes, an owner token cannot access another owner's data, only super-admin tokens reach admin routes.

## Deliverable
All three roles can authenticate, receive valid tokens, and are correctly restricted by role and ownership — verified with explicit isolation tests.

## Dependency Note
Every module from Phase 2 onward imports `auth.middleware` for route protection and the ownership-scoping helper for data isolation. Any gap discovered later means revisiting every dependent module, so test this phase thoroughly before proceeding.

## Product Decisions Resolved Before Implementation (Added After Review)

1. **Owner account creation is admin-invited, not self-service.** There must be no public "register as owner" endpoint. Owner accounts are created either directly by a Super-Admin (manual creation with a temporary password/invite link) or via an "invite owner" endpoint restricted to the Super-Admin role. Document this clearly in `auth.routes` — the public-facing routes are limited to student OTP registration/login and owner/admin login only.

2. **The first Super-Admin account must be created via a one-time seed script**, not through any exposed API endpoint. There must be no public or authenticated endpoint that can create a super-admin account. If a "create additional super-admin" capability is needed later, it must be restricted to existing super-admins only (built in Phase 7, not here).

3. **OTP delivery provider decision (finalized):** The project targets Egypt only at this stage. Build `otp.service` behind an interface/abstraction (e.g., a `sendOtp(phone, code)` function) so the provider can be swapped without touching calling code. For Phase 1, implement the OTP sending function as a **mock/console-log implementation** (no real SMS sent yet, code is logged/returned for development testing). Do not integrate Unifonic — it is optimized and priced for the Gulf market (Saudi Arabia/UAE) and is not the right fit for an Egypt-only launch. The real integration will use a **local Egyptian SMS/OTP gateway provider** (e.g., SMS Misr or a comparable Egypt-focused provider, to be finalized after a pricing quote comparison), integrated in a later phase once real send volume is needed — this keeps Phase 1 unblocked and avoids committing to a paid provider before it's needed.

4. **Enforce a unique constraint on student phone number and owner/admin email at the database level**, not just application-level validation, to prevent duplicate account creation.

5. **On password reset, invalidate all existing refresh tokens for that account** — a reset should force re-authentication everywhere, not just update the password while old sessions remain valid.
