# CLAUDE.md — Engineering ground rules

These rules apply to every session in this repo, not just the current
task. Follow them without being re-asked.

## Workflow

1. **architect** subagent turns a requirement into a backlog: 3-8 tasks, each with acceptance
   criteria and likely files. Read-only - it never writes code.
2. **coder** subagent implements one backlog task at a time against its acceptance criteria.
3. **reviewer** subagent checks the coder's changes against acceptance criteria, the rules below,
   and the four data questions in its own definition. Verdict: `READY_TO_MERGE` or
   `CHANGES_REQUIRED`.
4. Iterate coder -> reviewer until `READY_TO_MERGE`.

Subagents auto-trigger from their `description` field (see `.claude/agents/`). To force one
explicitly: "have the architect subagent break this down" / "have the coder subagent implement
task 2" / "have the reviewer subagent check this."

Each subagent's model is set in its own frontmatter - writing "Model: X" in a prompt does nothing
on its own. Architect and reviewer run on a stronger model because they make judgement calls;
coder runs on a faster one for well-specified implementation. For a task touching auth, scoped
links, an AI-to-record path, or a statutory clock, escalate explicitly - e.g. "have the coder
subagent do this on opus" - a model named at invocation overrides the default.

Leave `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset or `0` (`.claude/settings.json` sets it). It
spawns fully independent parallel sessions, built for parallel exploration rather than a
sequential architect -> coder -> reviewer pipeline.

When handing work between agents, compress context to: goal (1-2 sentences), acceptance criteria,
current state, open questions, files touched, risks. Aim well under 300 tokens; never re-paste the
prior conversation.

## Pipeline

Four workflows in `.github/workflows/`, and what each one is for:

- **PR** (`pr.yml`) - typecheck, lint, build, on every pull request and on pushes to `staging` and
  `main`. No secrets and no database, so it runs on forks. These are the checks branch protection
  should require.
- **Tests** (`tests.yml`) - Vitest, then Playwright sharded three ways. Every job boots its own
  Supabase stack and replays `supabase/migrations` from empty, so the migration history is
  exercised on every run and no two runs share a database. Holds no secrets: the AI calls are
  stubbed and email is unconfigured.
- **Preview** (`preview.yml`) - a Vercel preview URL per pull request, posted as a sticky comment.
  Skipped for forks, because it holds a deploy token.
- **Staging** (`staging.yml`) - push to `staging` deploys and moves the staging URL.
- **Production** (`production.yml`) - `workflow_dispatch` only, gated on the `production`
  environment. Applies no database migrations, deliberately.

Both deploy workflows end by reading `/api/build-info` back from the live domain and failing if the
commit serving traffic is not the commit that triggered the run. `prebuild` writes that file from
the git SHA; don't remove either half, and don't let a route or a header stop `/api/build-info`
being reachable unauthenticated - the check runs before any session exists.

Schema changes are not deployed. A migration reaches a hosted database as a separate, explicit,
reviewed step.

### Environment variables

A `NEXT_PUBLIC_*` variable must be stored as a plain variable in Vercel, never as a **Sensitive**
one. Sensitive values are withheld from the build: Next then inlines nothing into the client
bundle and the server throws `NEXT_PUBLIC_SUPABASE_URL is not set` on any page that resolves a
session. This took production down on 17 Sep 2026 and was invisible from the outside, because
`/login` still rendered and `/api/build-info` still answered with the right commit. Marking such a
value Sensitive protects nothing anyway — it is shipped to every visitor inside the JavaScript.

Everything else — the service-role key, the AI key, the Resend key — stays Sensitive. Those are
read at runtime under their own names and never need to reach the build.

Both deploy workflows now refuse to build when a public variable did not reach them, and both
check that the deployed homepage returns 200 rather than trusting `/api/build-info` alone.

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
