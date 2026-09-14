# Fractional DPO

A GDPR compliance workspace where the client company — not the DPO's account —
is the tenant. See `docs/fractional-dpo-design-resume.md` for the product
architecture; engineering ground rules are in `CLAUDE.md`.

**Built so far:** the tenancy layer, portfolio/workspace views, the Art. 30
register foundation, the DPIA data/approval foundation, and the AI-ready vendor
evidence/questionnaire/reconciliation tables that feed DPIA review. Incidents,
rights requests, training and the vendor-facing link/UI are still unbuilt; they
should land only after their access rules are expressed in RLS and tested.

## Running it

```bash
npm install
supabase start          # local Postgres + auth; prints keys for .env.local
npm run dev
```

`supabase start` uses the ports in `supabase/config.toml`, which are shifted off
the CLI defaults (54421/54422/…) so this stack can run alongside another local
Supabase project without fighting over ports.

## Tests

```bash
npm test        # Vitest — membership + RLS logic, and the access resolver
npm run test:e2e  # Playwright — tenant-isolation regression, real browser session
```

Both need `supabase start` running. The Vitest suite talks to a real Postgres on
purpose: RLS policies cannot be tested against a mock, and a suite that used the
service role would keep passing with the policies deleted.

## How access works

Three pieces, and all three have to agree before anything is returned:

| Layer | File | Job |
|---|---|---|
| Database | `supabase/migrations/0001_tenancy.sql` | RLS policies predicated on live membership. The enforcement boundary. |
| Predicates | `app.*` functions in the same file | One definition each of "who is this", "what tier do they hold here", "is this membership live". |
| Application | `src/lib/tenant-access.ts` | Resolves the session to its memberships; refuses a tenant id the session does not hold. Defence in depth. |

A person holds a row in `memberships` per tenant, with a validity window. That
window does double duty: it is both the access grant and — because nothing here
ever deletes a membership — the record that this DPO maintained this register
for that date range.

Four rules everything else follows:

- **A client-supplied tenant id grants nothing.** It is only ever matched against
  memberships resolved server-side from the caller's own session.
- **Default deny.** Every table has RLS on, and a command with no policy is
  refused. `tenants` has no INSERT policy and `memberships` has no DELETE policy;
  both are reached only through functions that check first.
- **Foreign tenants are 404, never 403.** A response that distinguishes "exists
  but isn't yours" from "doesn't exist" enumerates other companies' workspaces.
- **Revocation is immediate.** Membership is never carried in a JWT claim, so
  there is no token-lifetime window in which a removed DPO still has access.
