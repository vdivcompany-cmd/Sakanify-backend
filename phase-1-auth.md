# Phase 1 — Authentication & Role-Based Access

## Goal
Enable secure login/logout for all three user roles (Student, Owner, Super-Admin), each with distinct access permissions.

## Context for the Implementer
Students authenticate via phone number + OTP (no password). Owners and Super-Admins authenticate via email/password. All three roles must be strictly isolated — an endpoint accessible to one role must not be accessible to another unless explicitly designed to be shared.

## Steps

1. **Design the authentication data model.** Decide whether to use a single unified auth collection with a `role` field, or separate collections per role linked to a shared auth identity — document the decision and reasoning.

2. **Build phone + OTP authentication flow for students**: request OTP, verify OTP, issue session/token on success. Include OTP expiry and rate-limiting to prevent abuse.

3. **Build email/password authentication flow for Owners and Super-Admins**: registration (likely admin-invited or manually provisioned for owners), login, password hashing and storage best practices.

4. **Implement JWT-based session management**: access token + refresh token pattern, with reasonable expiry times for each role.

5. **Build role-guard middleware** that every protected endpoint in every future module will use to restrict access by role (student-only, owner-only, super-admin-only, or shared).

6. **Build ownership-scoping logic**: beyond role checks, an Owner must only be able to access data (buildings, students, requests) tied to their own account — never another owner's data. This is a critical multi-tenancy rule that applies to every module going forward.

7. **Build logout/session invalidation** for all roles.

8. **Build password reset flow** for Owners and Super-Admins (email-based).

9. **Test role isolation explicitly**: verify a student token cannot access owner endpoints, an owner token cannot access another owner's data, and only super-admin tokens can access admin-level endpoints.

## Deliverable
All three roles can register/log in, receive valid session tokens, and are correctly restricted to only the data and endpoints appropriate to their role — with ownership-scoping enforced for Owners specifically.

## Dependency Note
Every module from Phase 2 onward will use the role-guard middleware and ownership-scoping logic built here. Any gaps in isolation discovered later will require revisiting every module that depends on this phase, so testing role isolation thoroughly now is critical.
