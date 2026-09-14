/**
 * What a workspace currently needs from its DPO, and in what order.
 *
 * Extracted from the portfolio page when the single-tenant view became the
 * second caller — not before. Both screens have to agree about what is urgent,
 * what blocks what, and which facts are actually evidenced. Two copies of those
 * rules would drift silently: a queue that orders differently on two screens is
 * not a cosmetic bug, it is two different answers to "what should I do next".
 *
 * Presentation deliberately stays in each page. The portfolio renders a compact
 * card per workspace and the tenant view renders one workspace in full; markup
 * drift between those is visible on sight, where rule drift is not.
 *
 * WHAT IS IN THE QUEUE, AND WHAT IS NOT
 *
 * Incidents, rights requests and training do not exist as tables. Nothing here
 * invents them. Every item below is derived from a row that is already in the
 * schema, so the queue is short and true rather than long and illustrative.
 * When those tables arrive they add `QueueItem`s to the same list; the ordering
 * and dependency rules do not change.
 */

import type { LegalBasis } from "./legal-basis";

// ---------------------------------------------------------------------------
// Confidence tagging (§7)
//
// Every field the product states about a company carries where it came from.
// `stated` is a human's answer, `inferred` is derived from something else and
// could be wrong, `unknown` is an admission. Shown, never hidden: a DPO signing
// their name to a register needs to know which facts are actually evidenced,
// and a field that looks the same whether it was answered or guessed is worse
// than no field at all.
// ---------------------------------------------------------------------------
export type Confidence = "stated" | "inferred" | "unknown";

export interface TaggedField {
  label: string;
  value: string | null;
  confidence: Confidence;
  /** Why it carries that tag — provenance, not decoration. */
  basis: string;
}

export type Owner = "you" | "company" | "outside";

export interface QueueItem {
  id: string;
  /** The work, named. Never a status number. */
  title: string;
  detail: string;
  /** Which area it belongs to — shown, but deliberately not what it sorts by. */
  where: string;
  waitingOn: string;
  owner: Owner;
  /** Days until it runs out. Negative is overdue. Null means no clock yet. */
  daysLeft: number | null;
  clock: string;
  action: "Decide" | "Chase" | "Review" | "Open";
  /** Severity breaks ties for items that have no clock at all. */
  severity: number;
  /** id of an item that must be resolved before this one can be. */
  blockedBy?: string;
}

export interface TenantRow {
  id: string;
  name: string;
  status: "active" | "read_only" | "suspended";
  legal_basis: LegalBasis;
  status_changed_at: string;
  created_at: string;
}

/**
 * Just enough of a register row to tell whether it still needs a DPIA.
 * The register screen reads the full row; the queue only needs this.
 */
export interface ActivityRiskRow {
  id: string;
  tenant_id: string;
  purpose: string;
  dpia_risk_flag: boolean;
  /** Whether any DPIA references this activity, of any status. */
  has_dpia: boolean;
}

/**
 * AI output that is waiting for DPO review.
 *
 * The queue deliberately needs only a count and broad kind. The suggestion
 * itself carries the source excerpt and confidence score; duplicating that
 * into the queue would make a summary screen look like the review screen.
 */
export interface AiSuggestionRow {
  id: string;
  tenant_id: string;
  status: "pending_dpo_review" | "approved";
  kind: string;
}

export interface MemberRow {
  id: string;
  tenant_id: string;
  tier: "active_dpo" | "staff" | "external_scoped";
  active_from: string;
  active_to: string | null;
  person: {
    id: string;
    email: string;
    full_name: string | null;
    auth_user_id: string | null;
  } | null;
}

/** Columns both screens read. Stated once so they cannot ask for different ones. */
export const TENANT_COLUMNS = "id, name, status, legal_basis, status_changed_at, created_at";

/**
 * The membership select, with the foreign key named.
 *
 * `memberships` points at `people` twice — once as the member (person_id) and
 * once as whoever revoked them (revoked_by) — so an unqualified embed is
 * ambiguous, PostgREST refuses the entire query, and the queue silently comes
 * back empty. That happened. Naming the constraint here means neither screen
 * can reintroduce it.
 */
export const MEMBER_COLUMNS =
  "id, tenant_id, tier, active_from, active_to, " +
  "person:people!memberships_person_id_fkey(id, email, full_name, auth_user_id)";

/** What the queue needs from the register, on both screens. */
export const ACTIVITY_RISK_COLUMNS = "id, tenant_id, purpose, dpia_risk_flag";

/** What the queue needs from cross-product AI suggestions, on both screens. */
export const AI_SUGGESTION_COLUMNS = "id, tenant_id, status, kind";

const DAY = 86_400_000;

/**
 * Whole days between two instants, rounded down.
 *
 * Down rather than nearest, deliberately: for a deadline, understating the time
 * remaining is the safe direction to be wrong in. "Expires in 2d" on something
 * with 2.9 days left costs a DPO nothing; "3d" on something with 2.1 left could
 * cost an auditor their access mid-review.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY);
}

/**
 * "Ordered by what runs out first, not by which tab it lives in."
 *
 * Sorting by area would group the work by which part of the product happens to
 * own it, which is an implementation detail rather than a fact about the DPO's
 * week. Anything with a clock sorts by that clock, most overdue first. Anything
 * without one sorts after, by severity — an item with no deadline is not
 * therefore unimportant, it just cannot claim a place in the dated run.
 */
export function byUrgency(a: QueueItem, b: QueueItem): number {
  if (a.daysLeft !== null && b.daysLeft !== null) return a.daysLeft - b.daysLeft;
  if (a.daysLeft !== null) return -1;
  if (b.daysLeft !== null) return 1;
  return b.severity - a.severity;
}

/** How urgently an empty or single-occupant Active DPO seat reads (§6). */
const BASIS_SEVERITY: Record<LegalBasis, number> = {
  mandatory: 30, // Art. 37 obligation — an empty seat is a live breach
  contractual: 20, // a representation already made to a customer becomes false
  voluntary: 10, // governance lapse, and Art. 37(4) duties still attach
};

const BASIS_CONSEQUENCE: Record<LegalBasis, string> = {
  mandatory: "Art. 37 requires a DPO here, so an empty seat is a live breach.",
  contractual: "A customer was told this company has a DPO. An empty seat makes that false.",
  voluntary: "Self-designated, but Art. 37(4) independence duties attach once designated.",
};

/** §5: a read-only tenant is purged after a year, not immediately. */
const PURGE_AFTER_DAYS = 365;

export function liveMembers(members: MemberRow[], now: Date): MemberRow[] {
  return members.filter(
    (m) => new Date(m.active_from) <= now && (!m.active_to || new Date(m.active_to) > now)
  );
}

/**
 * Everything this tenant currently needs from its DPO.
 *
 * `members` must already be this tenant's rows; the filter below is a backstop
 * rather than the boundary — the boundary is RLS, and then the caller's query.
 * Each branch names the design-resume rule it implements.
 */
export function queueFor(
  tenant: TenantRow,
  members: MemberRow[],
  now: Date,
  activities: ActivityRiskRow[] = [],
  aiSuggestions: AiSuggestionRow[] = []
): QueueItem[] {
  const items: QueueItem[] = [];
  const live = liveMembers(
    members.filter((m) => m.tenant_id === tenant.id),
    now
  );

  // §5 — the retention clock. A lapsed card must not delete a compliance
  // register, but it does start a countdown, and the countdown is the leverage.
  if (tenant.status === "read_only") {
    const purgeOn = new Date(new Date(tenant.status_changed_at).getTime() + PURGE_AFTER_DAYS * DAY);
    const daysLeft = daysBetween(now, purgeOn);
    items.push({
      id: `${tenant.id}:read-only`,
      title: "Workspace is read-only",
      detail:
        "Billing lapsed. The register is intact and readable, but nothing can be changed, and it is purged when the year runs out.",
      where: "Governance",
      waitingOn: "Billing",
      owner: "outside",
      daysLeft,
      clock: daysLeft < 0 ? `Purge overdue ${-daysLeft}d` : `Purged in ${daysLeft}d`,
      action: "Open",
      severity: 40,
    });
  }

  // §4 tier 3 — external scoped access is time-limited by design, so every
  // grant has an expiry worth seeing before an auditor loses access mid-review.
  for (const grant of live.filter((m) => m.tier === "external_scoped" && m.active_to)) {
    const daysLeft = daysBetween(now, new Date(grant.active_to!));
    items.push({
      id: `${tenant.id}:external:${grant.id}`,
      title: "External access expires",
      detail: `${grant.person?.email ?? "An external reviewer"} holds a scoped grant on this workspace. It ends on its own; extend it only if the review is still running.`,
      where: "Audit",
      waitingOn: grant.person?.full_name ?? grant.person?.email ?? "External reviewer",
      owner: "outside",
      daysLeft,
      clock: daysLeft < 0 ? `Expired ${-daysLeft}d ago` : `Expires in ${daysLeft}d`,
      action: "Review",
      severity: 15,
    });
  }

  // §5 — zero-Active-DPO must be an explicit choice, never an automatic
  // promotion. One seat filled is one revocation away from that choice, and how
  // bad the empty seat would be is decided by §6's legal basis.
  const activeDpos = live.filter((m) => m.tier === "active_dpo");
  if (activeDpos.length === 1) {
    items.push({
      id: `${tenant.id}:sole-dpo`,
      title: "You are the only Active DPO",
      detail: `No successor is named. ${BASIS_CONSEQUENCE[tenant.legal_basis]}`,
      where: "Governance",
      waitingOn: "You",
      owner: "you",
      daysLeft: null,
      clock: "No successor",
      action: "Decide",
      severity: BASIS_SEVERITY[tenant.legal_basis],
    });
  }

  // Art. 35 — special-category processing recorded with no assessment against
  // it. `dpia_risk_flag` is a generated column on the register, so this cannot
  // drift out of step with what the activity actually records.
  //
  // Undated but weighted above the governance items: a missing DPIA on
  // high-risk processing is not a gap in the paperwork, it is processing
  // happening now that Art. 35 says should have been assessed first. It still
  // sorts below anything with a real clock, because an item with a deadline is
  // the one that stops being possible.
  const needAssessment = activities.filter(
    (a) => a.tenant_id === tenant.id && a.dpia_risk_flag && !a.has_dpia
  );
  if (needAssessment.length > 0) {
    items.push({
      id: `${tenant.id}:dpia-needed`,
      title:
        needAssessment.length === 1
          ? "DPIA needed"
          : `${needAssessment.length} activities need a DPIA`,
      detail:
        needAssessment.length === 1
          ? `"${needAssessment[0].purpose}" records special-category data and has no assessment against it.`
          : `${needAssessment.length} register entries record special-category data with no assessment against them.`,
      where: "Assessments",
      waitingOn: "You",
      owner: "you",
      daysLeft: null,
      clock: "Not started",
      action: "Open",
      severity: 35,
    });
  }

  // AI is useful only while it is still reviewable. A pending suggestion is
  // surfaced as DPO work; an approved one disappears from the queue because the
  // review stamp has happened, even though applying it may remain a separate
  // product action.
  const pendingAi = aiSuggestions.filter(
    (s) => s.tenant_id === tenant.id && s.status === "pending_dpo_review"
  );
  if (pendingAi.length > 0) {
    const kinds = new Set(pendingAi.map((s) => s.kind));
    items.push({
      id: `${tenant.id}:ai-suggestions`,
      title:
        pendingAi.length === 1
          ? "AI suggestion needs review"
          : `${pendingAi.length} AI suggestions need review`,
      detail:
        kinds.size === 1
          ? `A ${formatAiKind([...kinds][0])} suggestion has source text and a confidence score ready for DPO review.`
          : `${kinds.size} AI-assisted areas have source text and confidence scores ready for DPO review.`,
      where: "AI review",
      waitingOn: "You",
      owner: "you",
      daysLeft: null,
      clock: "Pending review",
      action: "Review",
      severity: 28,
      blockedBy: tenant.status === "read_only" ? `${tenant.id}:read-only` : undefined,
    });
  }

  // §4 tier 2 — the roster is the base object precisely so you can prove who
  // did NOT respond. Someone who never signed in cannot acknowledge anything,
  // so they are a hole in every future attestation, not just a pending invite.
  const unclaimed = live.filter((m) => m.tier === "staff" && m.person && !m.person.auth_user_id);
  if (unclaimed.length > 0) {
    const oldest = unclaimed.reduce((a, b) =>
      new Date(a.active_from) < new Date(b.active_from) ? a : b
    );
    const waiting = daysBetween(new Date(oldest.active_from), now);
    items.push({
      id: `${tenant.id}:unclaimed-roster`,
      title:
        unclaimed.length === 1
          ? "A rostered colleague has never signed in"
          : `${unclaimed.length} rostered colleagues have never signed in`,
      detail:
        "They are on the roster but hold no account, so nothing can be assigned to them and they cannot acknowledge a policy. Until they sign in, any completion figure that counts them is wrong.",
      where: "People",
      waitingOn: unclaimed[0].person?.full_name ?? unclaimed[0].person?.email ?? "Rostered staff",
      owner: "company",
      daysLeft: null,
      clock: `Rostered ${waiting}d ago`,
      action: "Chase",
      severity: 12,
      // A read-only workspace refuses roster writes — `app.tenant_is_writable`
      // enforces that in the database — so chasing this is wasted effort until
      // billing is sorted. The dependency is real, not illustrative.
      blockedBy: tenant.status === "read_only" ? `${tenant.id}:read-only` : undefined,
    });
  }

  return items.sort(byUrgency);
}

function formatAiKind(kind: string): string {
  return kind.replaceAll("_", " ");
}

/**
 * The facts each screen states about a company, with their provenance.
 *
 * Sector has no column anywhere. It is listed as `unknown` rather than omitted
 * because a missing row and an unanswered question look identical once you drop
 * them, and only one of those is a gap somebody should close.
 */
export function taggedFieldsFor(
  tenant: TenantRow,
  members: MemberRow[],
  now: Date,
  legalBasisLabel: string
): TaggedField[] {
  const live = liveMembers(
    members.filter((m) => m.tenant_id === tenant.id),
    now
  );

  return [
    {
      label: "DPO basis",
      value: legalBasisLabel,
      confidence: "stated",
      basis: "Answered by a person when this workspace was created.",
    },
    {
      label: "People",
      value: `${live.length} with access`,
      confidence: "inferred",
      basis:
        "Counted from live memberships, which is who can reach the workspace — not a stated headcount for the company.",
    },
    {
      label: "Sector",
      value: null,
      confidence: "unknown",
      basis: "Never asked. Shown rather than omitted so the gap is visible.",
    },
  ];
}

export const OWNER_FILTERS = ["everything", "you", "company", "outside"] as const;
export type OwnerFilter = (typeof OWNER_FILTERS)[number];

export const OWNER_FILTER_LABELS: Record<OwnerFilter, string> = {
  everything: "Everything",
  you: "On you",
  company: "With the company",
  outside: "Outside",
};

export function applyOwnerFilter(items: QueueItem[], filter: OwnerFilter): QueueItem[] {
  return filter === "everything" ? items : items.filter((item) => item.owner === filter);
}
