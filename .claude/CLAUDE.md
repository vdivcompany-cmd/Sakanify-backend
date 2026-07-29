# Sakanify Backend — Project Rules for Claude

## Documentation Rule (Mandatory — Applies After Every Phase)

After completing the implementation of **any phase** (Phase 0 through Phase 8, or any future phase added to this project), Claude must automatically generate a phase completion document. This is not optional and does not require the user to ask for it each time.

### What Must Be Produced

1. **A Markdown document written entirely in Arabic**, summarizing what was implemented in that phase.
2. **A PDF version of the same document**, generated from the Markdown (using the project's PDF generation skill/tooling).
3. Both files must be saved as project deliverables (not just shown in chat) and clearly named after the phase, e.g.:
   - `phase-4-booking-engine-report.md`
   - `phase-4-booking-engine-report.pdf`

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

The documentation and PDF generation must happen **immediately after the phase's code is complete and passing its tests** — not batched at the end of the whole project, and not skipped even for small phases.

### Language Rule

- The report content itself must be in **Arabic**.
- Code identifiers, file names, and technical terms (e.g., `bed.model`, MongoDB, JWT) may remain in English within the Arabic text, since translating technical terms would reduce clarity for the technical team.

### Why This Rule Exists

These per-phase reports serve as the official project audit trail for V Div and Sakanify stakeholders — they must be readable by non-technical stakeholders in Arabic, while still being precise enough for the technical team to use as a reference of what was actually built versus what was originally planned.

## Applies To
This rule applies to every current and future implementation phase of the `sakanify-backend` project, and should be treated as a standing instruction for the remainder of the project — it does not need to be repeated by the user for each phase.
