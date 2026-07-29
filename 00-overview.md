# Sakanify Backend — Build Plan Overview

## What This Is
Sakanify is a student housing management SaaS platform (by V Div), targeting Sohag, Egypt. This document set defines the **backend-only** build plan, broken into sequential phases. Each phase has its own file. **No code or implementation is included here** — this is a specification and planning document set intended to be handed to an engineering team/AI to implement.

Build order for the overall project: **Backend (this document set) → AI Agentic Automation Layer → Frontend.**

## System Roles
- **Student**: registers, submits KYC, requests beds
- **Owner (Landlord)**: manages buildings/apartments/beds, confirms/rejects requests, confirms cash payments
- **Super-Admin (V Div team)**: manages all owners/buildings platform-wide, handles subscription expansion requests

## Core Business Rules (must hold across all phases)
1. A bed can only be requested by one student at a time — no double-booking, ever (atomic locking required at the database level).
2. Payment is **cash-only** for now: student pays the owner in person, then the owner manually updates the student's status in the dashboard.
3. KYC is intentionally minimal: **National ID number, National ID photo, and student's photo** only. No selfie/face-match, no extra lifestyle fields except smoking preference.
4. No WhatsApp/notification layer is needed right now — the owner dashboard is the single source of truth for the owner.
5. The public-facing site only ever lists buildings that are actively subscribed/partnered — non-subscribed buildings never appear.
6. Every state change (bed status, payment status, request status) must be logged with who/when for audit purposes — this data will later feed analytics and the AI assistant.

## Recommended Tech Stack
- **Runtime/Framework**: Node.js with Express or NestJS
- **Database**: MongoDB with Mongoose
- **Caching/Job Scheduling**: Redis + Bull Queue (or node-cron for simpler scheduled jobs)
- **Auth**: JWT (access + refresh tokens), OTP verification for student/guardian phone numbers
- **File Storage**: S3-compatible object storage for ID photos and profile photos (never store binary files directly in MongoDB documents)
- **Validation**: Zod or Joi
- **Testing**: Jest

## Architecture Style
**Modular monolith** — one deployed application, but organized into self-contained feature modules (students, beds, requests, rentals, payments, subscriptions, admin, public-site, ai-assistant, audit). Each module owns its own routes/controllers/services/models. This keeps the codebase organized today and makes it possible to extract any module into a separate service later without a rewrite.

## Phase Index
| Phase | File | Focus |
|---|---|---|
| 0 | phase-0-foundation.md | Project setup, config, roles, error handling |
| 1 | phase-1-auth.md | Authentication & role-based access |
| 2 | phase-2-students-kyc.md | Student registration & simplified KYC |
| 3 | phase-3-buildings-apartments-beds.md | Property structure hierarchy |
| 4 | phase-4-booking-engine.md | Request/booking engine with atomic bed locking |
| 5 | phase-5-cash-payment.md | Cash payment tracking & confirmation |
| 6 | phase-6-subscriptions.md | Owner subscription tiers & bed capacity |
| 7 | phase-7-admin.md | Super-Admin / V Div control center |
| 8 | phase-8-public-site.md | Public-facing listing API (subscribed buildings only) |

## What Comes After the Backend
- **AI Agentic Automation Layer**: LangChain + LangGraph for a structured-query chatbot (e.g., "who hasn't paid this month?") built on top of this backend's data, using a text-to-query pattern rather than a vector database initially.
- **Frontend**: built only after the backend above is stable and tested, including the chatbot interface for the AI layer.

Each phase file that follows should be implemented **in order** — later phases depend on the data models and business logic established in earlier ones.
