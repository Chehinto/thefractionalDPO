/**
 * Persistent tab bar for one tenant workspace.
 *
 * Why this file exists: there was no `layout.tsx` anywhere under this segment,
 * so every page hand-rolled its own single "← Workspace" link (or, for
 * `/my-tasks` and `/request-vendor`, none at all), and a user following one
 * link had no way back to the others without editing the URL. This layout is
 * the fix — a tab bar that persists across every page in the workspace.
 *
 * WHAT THIS FILE DELIBERATELY IS NOT: an access check.
 *
 * It calls `requireSession()` — never `requireMembership()` — reads the
 * membership list that comes back, and uses it only to decide which tab
 * labels to draw. It never calls `notFound()` and never throws: no session,
 * no membership for this tenant, or a tier this file doesn't have a tab set
 * for (`external_scoped`) all fall through to "no tab bar", and `{children}`
 * renders exactly as it would have with no layout at all. Every page under
 * this segment keeps its own `requireMembership(tenantId, ...)` call,
 * unchanged, with the same tier argument it already had — that call is still
 * the only thing deciding whether the page itself renders.
 *
 * Why the line between "decoration" and "enforcement" matters enough to say
 * twice: the moment this layout starts refusing requests, it *looks* like
 * enforcement, and the next page written under this segment is the one that
 * gets written without its own membership check — on the reasonable-sounding
 * but wrong assumption that "the layout already handles it". A route that is
 * reachable because the one thing guarding it turned out to live one segment
 * up, and silently stopped being called on some code path, is precisely the
 * default-deny failure CLAUDE.md calls out. So: default deny stays enforced
 * exactly once per page, at the page.
 *
 * Deliberately NOT wrapped in React `cache()` or any other memo.
 * `tenant-access.ts` documents, as a rule, that membership resolution is a
 * live database read on every call — nothing cached in module scope, a
 * request-scoped memo, or the JWT — specifically because a cached answer goes
 * on granting access for as long as the cache lives, which is wrong the
 * instant a membership is revoked. Memoising the call here would quietly
 * reintroduce that. The accepted cost is one extra `my_memberships()` round
 * trip per full (non-client) page load.
 *
 * Known, accepted staleness: layouts are cached client-side and do not
 * re-render between sibling pages during client navigation, so if a caller's
 * tier is revoked mid-session, this tab bar can keep showing the old set until
 * a hard reload. That is tolerable only because the tab bar is a hint, never a
 * gate — clicking a stale tab still lands on a page that runs its own live
 * `requireMembership` check and 404s there, immediately, if access no longer
 * holds.
 */

import { requireSession } from "@/lib/tenant-access";
import { TAB_SETS, type WorkspaceTab } from "./tenant-tabs";
import { TenantTabBar } from "./tenant-tab-bar";

function tabSetFor(tier: string | undefined): readonly WorkspaceTab[] | null {
  return tier === "active_dpo" || tier === "staff" ? TAB_SETS[tier] : null;
}

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  let tabs: readonly WorkspaceTab[] | null = null;
  try {
    const session = await requireSession();
    const membership = session.memberships.find((m) => m.tenantId === tenantId);
    tabs = tabSetFor(membership?.tier);
  } catch {
    // requireSession() throws for "not signed in" and, separately, if the
    // membership RPC itself fails. No tab bar is the safe answer to either:
    // the page underneath still runs its own live check and renders whatever
    // it always rendered for that case (a sign-in prompt, or its own error
    // state) — this layout failing softly here never hides that.
  }

  return (
    <>
      {tabs ? <TenantTabBar tenantId={tenantId} tabs={tabs} /> : null}
      {children}
    </>
  );
}
