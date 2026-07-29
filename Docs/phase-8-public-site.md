# Phase 8 — Public Site API

## Goal
Provide the API layer powering the public-facing directory ("Main Site") that lists only buildings actively subscribed to Sakanify.

## Context
Buildings not subscribed must never appear. Location filtering is area/neighborhood-based (not distance-based, since the university is spread across a wide area), and any transport info referenced must be based only on the official recognized bus stop, never unofficial gathering points.

## Folders & Files to Create This Phase

```
src/modules/public-site/
├── public.routes             → List buildings, get building detail, submit lead request, get transparency counters
├── public.controller
└── public.service              → Subscribed-only filtering logic, area-based search, lead creation into Requests module
```

## Implementation Steps

1. Build the public building-listing endpoint: returns only buildings whose subscription status (Phase 6) is active.
2. Build area/neighborhood-based filtering (not distance-based).
3. Build a building detail endpoint showing verified info (occupancy indicator, verified badge) without exposing sensitive owner/tenant data.
4. Build the "Request to View/Book" lead endpoint: creates a record in the `requests` module (Phase 4) exactly as if submitted through the authenticated student flow, so owners see it in the same pending-requests queue.
5. Build a public transparency counter endpoint: aggregate non-sensitive numbers (total verified students, total verified/subscribed buildings).
6. Ensure strict data minimization: no student personal data, no owner internal data, no unverified building data returned by any endpoint here.

## Deliverable
A public API listing only subscribed, verified buildings with area-based filtering, generating real leads into the core booking engine, exposing only non-sensitive aggregate indicators.

## Dependency Note
Depends on Phase 4 (Requests) to receive leads and Phase 6 (Subscriptions) to determine listing eligibility. Build last among backend phases, since it consumes nearly every other module's data.
