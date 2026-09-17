/**
 * The two navigable tab sets for the tenant workspace, and the pure logic that
 * decides which tab lights up for a given route segment.
 *
 * Kept framework-free (no `next/navigation`, no `"use client"`) on purpose: the
 * segment→tab mapping is exactly the kind of matching logic CLAUDE.md asks to
 * be Vitest-covered, and a file that only exports plain data and pure
 * functions can be imported by a test without pulling in React or Next's
 * client runtime.
 *
 * Tab membership is an explicit allow-list per tier, not derived from
 * `requireMembership`'s tier options. That is deliberate: adding a third tab
 * set for a future membership tier means someone has to decide, here, exactly
 * which links that tier is allowed to see — never inherit whatever set happens
 * to already exist.
 */

export type MembershipTierWithTabs = "active_dpo" | "staff";

export interface WorkspaceTab {
  readonly id: string;
  readonly label: string;
  /**
   * Path segment(s) immediately under `/tenants/[tenantId]` that this tab
   * covers, as reported by `useSelectedLayoutSegment()`. `null` means the
   * tenant root itself (no further segment) — a real, distinct value from
   * "no match", not an absence to be treated as falsy.
   */
  readonly segments: readonly (string | null)[];
}

/**
 * Active DPO: the full workspace. §4 tier 1. Incidents is here and nowhere
 * else — it holds the Art. 33 breach register and the 72-hour notification
 * clock, and staff have no legitimate reason to know it exists, let alone open
 * it (a staff member who could see the tab could also 404 their way into
 * confirming a breach was logged, which is itself a disclosure).
 */
export const ACTIVE_DPO_TABS: readonly WorkspaceTab[] = [
  { id: "overview", label: "Overview", segments: [null] },
  { id: "register", label: "Register", segments: ["register"] },
  // Software discovery, vendor evidence, the AI review inbox, and the raw
  // "request a vendor" form are all entry points into the same intake funnel
  // (§2 detection paths), so any of them highlights the one Intake tab rather
  // than four separate ones a DPO would have to learn apart.
  {
    id: "intake",
    label: "Intake",
    segments: ["intake", "software-discovery", "vendors", "ai-review", "request-vendor"],
  },
  { id: "incidents", label: "Incidents", segments: ["incidents"] },
  { id: "training-admin", label: "Training", segments: ["training-admin"] },
  { id: "roster", label: "People", segments: ["roster"] },
  { id: "settings", label: "Settings", segments: ["settings"] },
];

/** Staff: §4 tier 2. Deliberately excludes anything that would disclose the
 * register's full contents, the DPIA pipeline, or that incidents are tracked
 * at all. */
export const STAFF_TABS: readonly WorkspaceTab[] = [
  { id: "my-tasks", label: "Home", segments: ["my-tasks"] },
  { id: "register", label: "Register", segments: ["register"] },
  { id: "training", label: "My training", segments: ["training"] },
  { id: "request-vendor", label: "Raise a request", segments: ["request-vendor"] },
];

export const TAB_SETS: Record<MembershipTierWithTabs, readonly WorkspaceTab[]> = {
  active_dpo: ACTIVE_DPO_TABS,
  staff: STAFF_TABS,
};

/** A tab's first segment is its own destination; `null` means the tenant root. */
export function hrefForTab(tenantId: string, tab: WorkspaceTab): string {
  const segment = tab.segments[0];
  return segment === null ? `/tenants/${tenantId}` : `/tenants/${tenantId}/${segment}`;
}

/**
 * Which tab, if any, is active for the segment `useSelectedLayoutSegment()`
 * reports one level below this layout. Returns `null` both when nothing
 * matches (e.g. `/links`, which has no tab in either set) and when `tabs` is
 * empty — callers only need to know whether *a* tab should be highlighted.
 */
export function activeTabId(tabs: readonly WorkspaceTab[], segment: string | null): string | null {
  return tabs.find((tab) => tab.segments.includes(segment))?.id ?? null;
}
