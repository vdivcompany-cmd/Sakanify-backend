# Phase 6 — Owner Subscriptions & Bed Capacity

## Goal
Track each Owner's subscription tier (how many beds/buildings they're allowed to manage) and support requests to expand that capacity.

## Context for the Implementer
Sakanify's business model is tiered by bed capacity (e.g., "50-bed package" at a given monthly price). This module tracks each owner's current tier and actual usage, and provides the request pathway for owners to ask for more capacity — which the Super-Admin module (Phase 7) will approve or reject.

## Steps

1. **Build the Subscription model**: owner reference, current tier/package name, total bed capacity allowed, monthly price, subscription status (active/overdue/suspended), renewal date.

2. **Build usage calculation logic**: compare the owner's actual bed count (from Phase 3) against their subscription's allowed capacity, to determine current utilization (e.g., "48 of 50 beds used").

3. **Build a warning threshold**: flag when an owner is approaching their capacity limit (e.g., 90%+ utilized), so this can surface as an alert in their dashboard later.

4. **Build the "Request Bed Expansion" endpoint** for owners: submits a request specifying desired new capacity, which creates a record for the Super-Admin expansion queue (built in Phase 7).

5. **Build subscription status transitions**: active, overdue (e.g., non-payment of the platform subscription itself, separate from tenant rent), suspended — and the business rules for what an owner can/cannot do in each state (e.g., a suspended owner may be blocked from adding new buildings or accepting new requests).

6. **Ensure all subscription and capacity data ties back to the ownership-scoping rules from Phase 1** — an owner should only ever see and manage their own subscription.

## Deliverable
Each owner has a tracked subscription tier with real usage data, can request capacity expansion, and the system enforces basic capacity-based rules.

## Dependency Note
The expansion requests created here are consumed and approved/rejected in Phase 7's Super-Admin expansion queue — the request record structure should be designed with that downstream consumer in mind.
