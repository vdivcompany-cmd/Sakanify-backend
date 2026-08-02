# Phase 8 — Public Site API

## Goal
Provide the API layer powering the public-facing directory ("Main Site") that lists only buildings actively subscribed to Sakanify.

## Context
Buildings not subscribed must never appear. Location filtering is area/neighborhood-based (not distance-based, since the university is spread across a wide area), and any transport info referenced must be based only on the official recognized bus stop, never unofficial gathering points.

**This is the first fully public (unauthenticated) surface in the backend.** Every endpoint here is reachable with no login and no rate-limit-by-account, so it needs its own abuse-resistance treatment distinct from every prior phase.

## Critical Design Decision — Public Leads Are NOT Requests

The original scope described the "Request to View/Book" endpoint as creating a record directly in the Phase 4 `requests` module, "exactly as if submitted through the authenticated student flow." **This is corrected here — it must NOT work that way.**

Phase 4's `request.service.createRequest()` performs a real atomic bed lock (`available` → `pending`) and assumes the requester is an authenticated, KYC-verified student. Wiring an anonymous public form directly into that flow would let anyone — with no account, no phone verification, no KYC — soft-lock any real bed with zero friction. At the project's target scale, this is a trivial denial-of-service vector: a single script could lock every available bed in Sohag by spamming this one public endpoint.

**Corrected design:** public interest submissions create a separate, lightweight `PublicLead` record (name, phone, note, bed/building reference, timestamp) — they do **not** touch bed status and do **not** create a `Request` document. Owners see these in a distinct "Public Leads" list, separate from their real Pending Requests queue (which remains reserved for vetted, authenticated students). A lead that wants to actually book must register normally (OTP + KYC, Phase 2) and submit a real request through the authenticated flow, same as any other student.

## Folders & Files to Create This Phase

```
src/modules/public-site/
├── public.routes             → List buildings, get building detail, submit public lead, get transparency counters
├── public.controller
├── public.service              → Subscribed-only filtering logic, area-based search
├── public-lead.model            → name, phone, note, bed reference, building reference (denormalized), submitted_at, status (new/contacted/dismissed)
└── public-lead.service           → Creates leads; does NOT touch bed.status or the requests module
```

## Implementation Steps

1. Build the public building-listing endpoint: returns only buildings whose subscription status (Phase 6) is active.
2. Build area/neighborhood-based filtering (not distance-based).
3. Build a building detail endpoint showing verified info (occupancy indicator as a rough percentage, verified badge) without exposing sensitive owner/tenant data or a bed-by-bed breakdown.
4. Build the "Submit Public Lead" endpoint per the corrected design above: creates a `PublicLead` record only — no bed status change, no `Request` document. Build the owner-facing endpoint to list/view their building's public leads, scoped via the Phase 1 ownership helper, separate from the Pending Requests list.
5. Build a public transparency counter endpoint: aggregate non-sensitive numbers (total verified students, total verified/subscribed buildings) via the same aggregation-pipeline approach established in Phase 7 — this is a public, likely high-traffic endpoint, so avoid recomputing from scratch on every request if it becomes a real load concern (a short cache, e.g. a few minutes, is a reasonable future optimization; not required to build now, just don't do anything that would make caching harder later).
6. Ensure strict data minimization: no student personal data, no owner internal data, no unverified building data, and no exact per-bed availability map returned by any endpoint here.
7. **Rate-limit every endpoint in this module by IP** (using the existing `rate-limiter.middleware` from Phase 0), since none of them require authentication. Apply a stricter limit specifically to lead submission than to browsing/listing, since lead submission is the one endpoint that writes data and is the more attractive abuse target.
8. Test explicitly: submitting a public lead never changes bed status, never creates a Request record, and is correctly rejected/rate-limited under repeated rapid submission from the same source.

## Deliverable
A public API listing only subscribed, verified buildings with area-based filtering, capturing genuine visitor interest as lightweight leads without touching the booking engine's security guarantees, and exposing only non-sensitive aggregate indicators.

## Dependency Note
Depends on Phase 6 (Subscriptions) to determine listing eligibility, and Phase 3 (Buildings/Beds) for detail/occupancy data. It does **not** depend on Phase 4 (Requests) the way originally scoped — public leads are intentionally decoupled from the booking engine. Build last among backend phases, since it consumes nearly every other module's data for reads.
