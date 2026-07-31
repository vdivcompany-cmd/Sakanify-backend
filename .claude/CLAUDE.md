# Sakanify Backend — Project Rules for Claude

> **Read this entire file before starting or resuming work on ANY phase.** These rules apply to the whole `sakanify-backend` project, are not optional, and do not need to be repeated by the user for every phase. This is a **real commercial product** — real landlords and real students will use it — so these rules exist to prevent security, data, and scaling problems before they happen, not to fix them after launch.

---

## 1. Documentation Rule (Mandatory — Applies After Every Phase)

After completing the implementation of **any phase** (Phase 0 through Phase 8, or any future phase added to this project), Claude must automatically generate a phase completion document. This is not optional and does not require the user to ask for it each time.

### What Must Be Produced

**A Markdown document written entirely in Arabic**, summarizing what was implemented in that phase.

The file must be saved as a project deliverable (not just shown in chat) and clearly named after the phase, e.g.:
- `phase-4-booking-engine-report.md`

**Note:** Only Markdown files are required. PDF generation is optional and not mandatory.

### Required Content of Each Phase Report (in Arabic)

Each report must include, at minimum:

- **اسم المرحلة ورقمها** (Phase name and number)
- **الهدف من المرحلة** (What this phase was meant to achieve)
- **الملفات والمجلدات اللي اتعملت فعلياً** (Actual files/folders created or modified during implementation — a real list reflecting the actual code written, not the original plan)
- **شرح تفصيلي لكل خطوة اتنفذت** (A detailed explanation of each implemented step — what it does and how it works, in plain Arabic, not just a code dump)
- **أي قرارات تقنية اتاخدت أثناء التنفيذ** (Any technical decisions made during implementation that weren't explicitly specified in the original phase spec — e.g., a library choice, a naming convention, an edge case handled a certain way)
- **الاختبارات اللي اتعملت والنتايج** (Tests written and their results, especially for critical logic like the atomic bed-locking in Phase 4)
- **أي انحراف عن الخطة الأصلية** (Any deviation from the original phase specification, and the reason for it)
- **الحالة النهائية للمرحلة** (Final status: fully complete / partially complete with notes / blocked, and why)

### Timing Rule

The documentation must be generated **immediately after the phase's code is complete and passing its tests** — not batched at the end of the whole project, and not skipped even for small phases.

### Language Rule

- The report content itself must be in **Arabic**.
- Code identifiers, file names, and technical terms (e.g., `bed.model`, MongoDB, JWT) may remain in English within the Arabic text, since translating technical terms would reduce clarity for the technical team.

### Why This Rule Exists

These per-phase reports serve as the official project audit trail for V Div and Sakanify stakeholders — they must be readable by non-technical stakeholders in Arabic, while still being precise enough for the technical team to use as a reference of what was actually built versus what was originally planned.

### Applies To
This rule applies to every current and future implementation phase of the `sakanify-backend` project, and should be treated as a standing instruction for the remainder of the project — it does not need to be repeated by the user for each phase.

---

## 2. Scale Context (Why These Rules Are Strict)

This system is being designed for a real target of approximately **1,000 subscribed buildings, each with up to ~500 students — roughly 500,000 students and a matching number of beds at scale.** Every rule below exists because of a specific, realistic failure mode at this scale. Do not treat any of these as optional "nice to haves" — treat them as part of the phase specification itself, even when a specific phase document doesn't repeat them explicitly.

---

## 3. Security Rules (Non-Negotiable, Apply From Phase 0 Onward)

1. **Never commit secrets.** `.env` must be in `.gitignore` from the very first commit. Connection strings, API keys, and passwords are never hardcoded in any source file, ever — not even temporarily "to test something."
2. **Sensitive files must be encrypted at rest.** National ID photos and student photos stored in the cloud bucket must use server-side encryption. Never store these files publicly accessible by default — use signed/expiring URLs for access, not permanent public links.
3. **Ownership-scoping is mandatory on every owner-facing endpoint, with no exceptions.** An Owner must never be able to read, list, or modify data (students, buildings, beds, payments) belonging to another Owner. This must be enforced at the query level (e.g., every query includes the authenticated owner's ID as a filter), not just at the UI level. Every module that touches owner-scoped data must include an explicit isolation test.
4. **Sanitize all user input before it reaches a database query**, to prevent NoSQL injection — never interpolate raw request input directly into a MongoDB query object.
5. **Passwords must be hashed with bcrypt or Argon2** — never stored in plaintext, never logged, never included in any API response, even hashed.
6. **JWT access tokens must be short-lived** (15–30 minutes). Refresh tokens must be stored securely (e.g., HttpOnly cookies, not accessible to frontend JavaScript) and must be revocable (e.g., on logout or suspicious activity).
7. **Rate-limit all authentication endpoints** (login, OTP request, OTP verify) to prevent brute-force attacks and OTP-spam abuse.
8. **Validate uploaded files by actual content type, not just file extension**, and enforce a maximum file size, to prevent malicious file uploads disguised as images.
9. **Every state-changing action on sensitive data (KYC, payments, account suspension, impersonation) must write to the audit log**, including who performed it, when, and what changed — this is both a security control and future legal protection for the business.
10. **The "Impersonate Owner" capability (Phase 7) is high-risk by design** — every impersonation session must be logged with start/end time and the acting super-admin's identity, and should be time-limited.
11. **Least privilege by default**: a new endpoint should default to the most restrictive access level required, and access should be deliberately widened only when justified — never default to "open" and restrict later.

---

## 4. Scalability & Performance Rules

1. **Every model must have appropriate indexes defined at the same time the model itself is created** — not added later as an afterthought. At minimum: index any field used to scope data to an owner (`owner_id`), any field used for status filtering (`status`), and any field used for lookups (`phone`, `national_id_number`).
2. **Every endpoint that returns a list must support pagination from day one** — no unpaginated "return all" endpoints, even if the current dataset is small during development. This applies to student lists, bed lists, request queues, payment histories, and audit logs.
3. **Configure MongoDB connection pooling explicitly** rather than relying on default settings, since the default pool size is not tuned for this project's expected concurrent load.
4. **Avoid N+1 query patterns** — when returning nested data (e.g., a building with its apartments and beds), use proper aggregation/population in a minimal number of queries rather than looping and querying per item.
5. **Design the atomic bed-locking operation (Phase 4) to be tested under concurrent load**, not just tested for correctness in a single-request scenario — this is the single most important correctness guarantee in the whole system given the target scale.
6. **Background jobs (request expiry, payment rollover) must be designed to process in batches**, not by loading the entire collection into memory at once, since these collections will grow into the hundreds of thousands of records.

---

## 5. Data Privacy & Legal-Readiness Rules

1. **Minimize data collection strictly to what has been explicitly approved** (see Phase 2 — National ID number, National ID photo, student photo, no more). Do not add "just in case" fields.
2. **Students must be able to have their KYC documents deleted/anonymized on request** in a future phase — design the KYC model now so this is possible without breaking foreign-key relationships to historical rental/payment records (e.g., don't delete the whole student record, support anonymizing just the sensitive fields).
3. **Audit logs are the source of truth in disputes** (e.g., "I paid but it shows unpaid") — every payment status change and rental status change must be traceable to a specific actor and timestamp, permanently, and this log must never be user-editable or deletable.

---

## 6. Testing Rules

1. **Every phase must include tests for its critical logic before being reported as complete** — "the code runs" is not sufficient evidence of correctness.
2. **Concurrency-sensitive logic (bed locking, payment status updates) must have a test that simulates simultaneous/near-simultaneous requests**, not just sequential ones.
3. **Every ownership-scoping rule must have an explicit negative test** — e.g., a test that confirms Owner A's token cannot retrieve Owner B's data, not just a test that confirms Owner A can retrieve their own data.
4. **Role-guard middleware must be tested for every role boundary** — student tokens rejected on owner/admin routes, owner tokens rejected on admin routes, and so on.
5. **Test results must be included in the mandatory phase report** (see Section 1), not just claimed as "tested."

---

## 7. Code Quality & Architecture Rules

1. **Follow the modular monolith structure exactly as specified in the phase and folder-structure documents** — do not introduce a different pattern (e.g., a shared "god model" file) without flagging it for review first.
2. **Every module is self-contained**: routes, controller, service, model, validation. Cross-module logic goes through service calls, not direct database access into another module's collection.
3. **Use the standardized API response format (from Phase 0) consistently across every single endpoint**, with no exceptions or ad-hoc response shapes.
4. **Any deviation from the phase specification must be explicitly flagged in the phase report** (per Section 1) — silent deviations are not acceptable, even small ones like a renamed field.
5. **Do not skip or silently simplify a specified step.** If a step seems unclear or a decision is genuinely required from the project owner, flag it in the report and ask, rather than guessing and proceeding.

---

## 8. Common Future Problems — Preemptive Solutions (Applied From Day One)

| Potential Future Problem | Preemptive Solution Applied Now |
|---|---|
| Slow queries once the database grows to hundreds of thousands of records | Indexes defined alongside every model from the start (Section 4.1) |
| Two students booking the same bed simultaneously | Atomic conditional database update, tested under concurrency (Phase 4, Section 4.5) |
| An owner accessing another owner's tenant data (data breach) | Mandatory ownership-scoping with negative tests on every module (Section 3.3, Section 6.3) |
| Leaked database credentials via committed code | `.env` + `.gitignore` enforced from Phase 0, secrets never hardcoded (Section 3.1) |
| Disputes over "did the student actually pay?" with no evidence | Immutable, actor-stamped audit log on every payment/status change (Section 5.3) |
| Server overload during peak signup periods (start of term) | Connection pooling, pagination, and batch-processing background jobs (Section 4.3, 4.6) |
| A stolen/expired JWT being usable indefinitely | Short-lived access tokens + revocable refresh tokens (Section 3.6) |
| Malicious file uploaded disguised as a student ID photo | Content-type validation + size limits on all uploads (Section 3.8) |
| Legal/privacy request to delete a student's sensitive data | KYC model designed for field-level anonymization without breaking rental history (Section 5.2) |
| A future feature silently bypassing existing security rules because "it's just a quick addition" | Every new endpoint defaults to least-privilege access; new modules must state which of these rules apply before implementation (Section 3.11) |
| Silent scope-creep or unspecified assumptions during implementation | Any ambiguity or deviation must be flagged in the phase report rather than resolved by guessing (Section 7.4, 7.5) |

---

## 9. Environment & Secrets Handling

1. Use `.env` for all environment-specific values (database connection string, JWT secrets, storage bucket credentials). Never hardcode these anywhere in source files.
2. `.env` must be listed in `.gitignore` before the first commit — verify this explicitly, don't assume it.
3. Only `.env.example` (with placeholder values, no real secrets) is ever committed to version control.
4. If a real credential is ever shared in plaintext (e.g., pasted in chat or a message), treat it as compromised and rotate it before production launch, even if it was only used in development.

---

## 10. Before Starting Any Phase — Checklist

Before writing any code for a phase, confirm:
- [ ] The relevant phase specification document has been read in full.
- [ ] This `CLAUDE.md` file has been read in full and its rules are understood to apply to this phase.
- [ ] Any prior phase this one depends on is complete and its tests are passing.
- [ ] Any open design decision relevant to this phase has been resolved by the project owner (not assumed).

After completing any phase, confirm:
- [ ] All implementation steps from the phase document are done, with no silent omissions.
- [ ] Indexes, pagination, and ownership-scoping (where applicable) are in place, per Sections 3 and 4.
- [ ] Tests for critical/concurrent logic exist and pass, per Section 6.
- [ ] The Arabic phase report (Markdown) has been generated per Section 1.
