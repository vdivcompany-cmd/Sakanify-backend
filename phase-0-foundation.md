# Phase 0 — Foundation

## Goal
Establish the architectural foundation that every later phase will build on. No business features are implemented in this phase — only the scaffolding, configuration, and shared infrastructure.

## Context for the Implementer
This is a **modular monolith** backend for a student housing SaaS platform. Three user roles exist: Student, Owner (Landlord), and Super-Admin. All later modules (students, beds, requests, payments, etc.) will be organized as self-contained folders under a `modules/` directory, each with its own routes, controller, service, and model files.

## Steps

1. **Initialize the project repository** with a modular folder structure separating `config/`, `modules/`, and `shared/` concerns. Do not put business logic directly in the app entry file.

2. **Set up the database connection layer.** Configure MongoDB connection handling that works across dev, staging, and production environments, with proper connection error handling and retry logic.

3. **Set up environment variable management.** Create a centralized environment loader/validator that fails fast at startup if required variables are missing, rather than failing silently later.

4. **Define shared constants and enums** that will be used across multiple modules: user roles (student/owner/super-admin), bed status values (available/requested/confirmed/vacating), payment status values (pending/rented, per the decision made in Phase 5), and request status values.

5. **Establish the role-based access control pattern** at the foundation level (the actual auth logic comes in Phase 1, but the constants, role definitions, and access-control conventions should be decided now so every later module follows the same pattern).

6. **Build a standardized API response format** (success/error response shapes) used consistently across every endpoint in every module, so the future frontend only ever needs to handle one response shape.

7. **Build centralized error-handling middleware** that catches errors from any module and returns them in the standardized format from step 6.

8. **Set up basic request logging middleware** (separate from the detailed audit logging that comes in later phases — this is just operational/debug logging).

9. **Set up file storage configuration** for future use (ID photos, profile photos) pointing to an S3-compatible bucket — configure the connection now even though the actual upload logic is built in Phase 2.

10. **Set up the shared job/scheduler infrastructure** (a single scheduling engine, e.g., using Redis + a queue library or node-cron) that later phases will plug into for scheduled tasks like request expiry and payment rollover. Build the engine itself now; specific jobs are added in later phases.

11. **Write basic health-check and environment-verification endpoints** to confirm the server, database, and storage connections are all working correctly.

## Deliverable
A running server, connected to the database, with:
- A defined modular folder structure ready to receive feature modules
- Standardized error handling and response format
- Role/constants definitions in place
- A working job scheduler engine (empty of actual jobs)
- No business features implemented yet

## Dependency Note
Every subsequent phase depends on this phase's conventions (response format, error handling, role constants, scheduler engine) being finalized first. Do not proceed to Phase 1 until these conventions are agreed upon, since changing them later means touching every module.
