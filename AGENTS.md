# AGENTS.md — Engineering ground rules

These rules apply to every session in this repo, not just the current
task. Follow them without being re-asked.

## Testing

Default to **Vitest**. Use it for anything that doesn't require an
actual rendered browser: business logic, schema/output validation,
matching and reconciliation logic (Prompt A/B outcomes), API route
handlers (via request/response mocking), confidence-tag handling,
utility functions. This should be the large majority of tests.

Use **Playwright** only when the thing being tested genuinely requires
a real browser or a real multi-step session — not as a default choice.
That means:
- Multi-page user journeys (staff member receives an assignment,
  answers it, DPO reviews and approves it).
- Tenant-isolation regression checks: log in as a member of Tenant A,
  attempt to reach Tenant B's data by URL/API manipulation, assert
  it's refused. This is the single highest-value use of Playwright in
  this codebase — access-control regressions are the most expensive
  kind to miss, and this product exists specifically to prevent them.
- Auth/session flows (login, invitation acceptance, magic links).

Playwright assertions must check **behavior and state** — visible
content, ARIA roles, HTTP status codes, redirect targets — never
fragile source-text matching. (AxioVendo's test suite leans on
text-matching in places; don't repeat that pattern here.)

Every new feature needs tests before it's considered done. Don't wait
to be asked, and don't skip tests on the reasoning that a feature is
"simple" — simple features are exactly where access-control mistakes
hide.

## Code structure

One feature, one file, as the default. A feature's validation,
business logic, and data access live together in the file that
implements it, not spread across a service layer / repository layer /
interface layer that only exists for one implementation.

Move something into a shared module only when a second feature
actually needs it — not preemptively. If you're building an
abstraction "in case it's needed later," don't; add it when the
second caller actually shows up.

File names should name the feature (`approve-processing-activity.ts`),
not the pattern (`handler.ts`, `service.ts`, or a generic `utils.ts`
used as a dumping ground).

## Security — when in doubt, take the more secure option

This product holds other companies' regulatory compliance records.
Default to paranoid, even at some cost to convenience or velocity:

- **Never trust a client-supplied tenant/org id.** Resolve the
  caller's tenant/membership server-side from their own session —
  the same pattern as `requireMember` in AxioVendo. A request can
  name whatever tenant it wants; only a server-side membership lookup
  decides what it can actually reach.
- **Enforce tenant isolation at the database layer (RLS), not just in
  application code.** Application-layer filtering that happens to be
  correct today is one refactor away from being wrong; a database
  policy isn't.
- **Foreign-tenant resource access returns 404, not 403.** Never let
  a response distinguish "exists but isn't yours" from "doesn't
  exist."
- **Default deny.** New data or a new feature is inaccessible until
  something explicitly grants access — never accessible until
  something explicitly blocks it.
- **AI-drafted output never writes to a canonical record directly.**
  Every draft (extraction, elicitation, reconciliation) lands as
  `pending_dpo_review`. Nothing touches the register, a DPIA, or any
  approved record without an explicit human-approval step in the code
  path. If you find yourself writing a path where AI output could
  reach a canonical table without going through approval, stop and
  flag it rather than continuing.
- **Hash tokens before storing them**, use short expirations by
  default, and check revocation against live state, never cached
  state.
- **When two implementations are both reasonable, pick the one that
  fails closed, not the one that fails open.** If you're genuinely
  unsure which one that is, say so and ask rather than guessing.

## Comments

Written for a mid-level developer who has never seen this codebase and
has to take it over with no handoff conversation. That means:

- Comment **why**, not what — especially anywhere the logic encodes a
  legal or business rule that isn't obvious from the code itself (why
  a retention threshold is proportional to stated cadence, why an
  extracted offset needs rebasing at a chunk boundary, why a
  confidence tag can't be silently upgraded from inferred to stated).
  A new developer should be able to understand the GDPR reasoning
  behind a check without having to go find the original design
  conversation.
- Don't comment the obvious. A line that already reads clearly in
  plain code doesn't need a comment restating it.
- Anywhere you deliberately chose the more secure but more complex
  option over a simpler one, say so in one line — that's what stops
  the next developer (or the next session of you) from "simplifying"
  it back into the insecure version.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
