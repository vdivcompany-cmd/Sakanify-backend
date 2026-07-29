# Phase 0 — Foundation

## Goal
Establish the architectural foundation that every later phase will build on. No business features are implemented in this phase — only scaffolding, configuration, and shared infrastructure.

## Context
This is a **modular monolith** backend for a student housing SaaS platform. Three roles exist: Student, Owner, Super-Admin. All feature modules live under `src/modules/`, each self-contained with its own routes/controller/service/model.

## Folders & Files to Create This Phase

```
sakanify-backend/
├── src/
│   ├── config/
│   │   ├── database.config           → MongoDB connection setup (host, retries, error handling)
│   │   ├── env.config                → Loads and validates all required environment variables at startup
│   │   ├── storage.config            → S3-compatible bucket connection settings (used later for uploads)
│   │   └── constants.config          → Shared enums: roles (student/owner/super-admin), bed status values, payment status values, request status values
│   │
│   ├── shared/
│   │   ├── middlewares/
│   │   │   ├── error-handler.middleware   → Catches errors from any module, returns standardized error response
│   │   │   ├── request-logger.middleware  → Basic operational logging (not the detailed audit log)
│   │   │   └── rate-limiter.middleware    → Basic abuse protection
│   │   ├── utils/
│   │   │   ├── date.util             → Shared date helpers
│   │   │   ├── response.util         → Standardized API success/error response shape used by every module
│   │   │   └── file-upload.util      → Shared file upload handling logic (used by kyc/students modules later)
│   │   └── jobs/
│   │       └── scheduler.core        → Central job/queue engine (Redis + Bull, or node-cron) — empty of actual jobs for now
│   │
│   ├── app.entry                     → Boots express/fastify app, mounts middlewares, will mount module routers as they're added
│   └── server.entry                  → Starts the process, connects to DB, starts listening
│
├── tests/
│   └── unit/                         → Placeholder, mirrors modules/ as they're added
│
└── .env.example                      → Template of all required environment variables
```

## Implementation Steps

1. Initialize the repo with the folder structure above. Do not put business logic in `app.entry` or `server.entry` — they only assemble and boot.
2. Implement `database.config` with connection handling that works across dev/staging/production and retries on failure.
3. Implement `env.config` to fail fast at startup if required env vars are missing.
4. Implement `constants.config` with all shared enums other modules will import (roles, bed statuses, payment statuses, request statuses).
5. Implement `response.util` — a single consistent shape for every API response (success and error) across the whole project.
6. Implement `error-handler.middleware` using that response shape.
7. Implement `request-logger.middleware` for basic request/response logging.
8. Implement `storage.config` — connect to the storage bucket now, even though upload logic is built in Phase 2.
9. Implement `scheduler.core` — the single scheduling engine that Phase 4 (request expiry) and Phase 5 (payment rollover) will register jobs into later.
10. Implement `file-upload.util` as a shared helper (actual usage starts in Phase 2).
11. Wire `app.entry` to load middlewares and be ready to mount future module routers.
12. Add a health-check endpoint verifying server, DB, and storage connections.

## Deliverable
A running server, connected to MongoDB, with standardized error handling/response format, shared constants, and a working (empty) job scheduler — no business features yet.

## Dependency Note
Every later phase imports from `config/` and `shared/` built here. Do not change these conventions once Phase 1 begins — changes here ripple through every module.
