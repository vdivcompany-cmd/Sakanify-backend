# Phase 8 — Public Site API

## Goal
Provide the API layer that will power the public-facing student housing directory — the "Main Site" — which lists only buildings actively subscribed to Sakanify.

## Context for the Implementer
This is a growth-driving feature: buildings that are not subscribed to Sakanify must never appear on the public site, by design. Location/search filtering is based on neighborhood/area within Sohag, not distance from the university (the university is spread across a wide area, so proximity search is not meaningful) — and any transport-related information referenced must be based only on the official recognized bus stop in front of the old university, not any unofficial gathering points.

## Steps

1. **Build the public building-listing endpoint**: returns only buildings whose subscription status (from Phase 6) is active — never suspended, expired, or unsubscribed buildings.

2. **Build area/neighborhood-based filtering**: allow students to filter listed buildings by neighborhood/area within Sohag, rather than by distance to any single point.

3. **Build a building detail endpoint** for the public site: shows verified building information (occupancy indicator, verified badge, general info) without exposing any sensitive owner or tenant data.

4. **Build the "Request to View/Book" lead-generation endpoint**: allows a prospective student to submit interest in a specific bed/building directly from the public site — this should create a record in the Request module (Phase 4) exactly as if the request came from the authenticated student flow, so owners see it in the same pending-requests queue.

5. **Build a public transparency counter endpoint**: returns aggregate, non-sensitive numbers such as total verified students and total verified/subscribed buildings on the platform, for display on the public site.

6. **Ensure strict data minimization**: confirm no student personal data, no owner internal data, and no unverified building data can ever be returned by any endpoint in this module.

## Deliverable
A public API that lists only subscribed, verified buildings with area-based filtering, generates real lead requests into the core booking engine, and exposes only non-sensitive aggregate trust indicators.

## Dependency Note
This module depends on Phase 4 (Requests) to receive leads, and Phase 6 (Subscriptions) to determine which buildings are eligible for public listing. It should be built last among the backend phases, since it is a consumer of nearly every other module's data.
