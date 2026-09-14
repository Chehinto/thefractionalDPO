/**
 * The portfolio dashboard.
 *
 * A fractional DPO's portfolio is not a stored object — §4 defines it as a
 * computed rollup across every tenant where they currently appear on the Active
 * DPO list. So this page derives it from live memberships on every request;
 * there is nothing to keep in sync and nothing to go stale.
 *
 * Everything here comes from the live schema. Where a fact does not exist yet
 * it is shown as `unknown` rather than omitted or invented — see the confidence
 * tags below.
 *
 * WHAT IS IN THE DASHBOARD, AND WHAT IS NOT
 *
 * The portfolio is intentionally aggregated. It may say that one vendor or
 * assessment needs review; it must not name the software, vendor, employee or
 * other source-level detail. Specific facts live inside the tenant workspace.
 *
 * The queue rules live in `@/lib/tenant-queue`, shared with the single-tenant
 * view. Only the presentation is here.
 */

import Link from "next/link";
import { requireSession, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { LEGAL_BASIS_LABELS } from "@/lib/legal-basis";
import {
  byUrgency,
  ACTIVITY_RISK_COLUMNS,
  AI_SUGGESTION_COLUMNS,
  MEMBER_COLUMNS,
  queueFor,
  taggedFieldsFor,
  TENANT_COLUMNS,
  type AiSuggestionRow,
  type ActivityRiskRow,
  type Confidence,
  type MemberRow,
  type QueueItem,
  type TenantRow,
} from "@/lib/tenant-queue";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PortfolioPage() {
  let session = null;
  try {
    session = await requireSession();
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-slate-50">
        <section className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-4 py-16">
          <div className="max-w-3xl">
            <p className="text-xs uppercase tracking-widest text-slate-500">Fractional DPO</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-normal text-slate-950 sm:text-5xl">
              Compliance work that keeps its evidence visible.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
              Run client workspaces, review AI-assisted drafts, keep source text beside every
              suggestion, and move records through DPO approval without turning model output into
              canonical compliance data.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            >
              Create an account
            </Link>
            <Link
              href="/login"
              className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800"
            >
              Sign in
            </Link>
          </div>

          <div className="mt-12 grid gap-3 sm:grid-cols-3">
            {[
              ["ROPA intake", "Capture new processing activity signals for DPO review."],
              ["Vendor evidence", "Review policies, questionnaires and vendor requests."],
              ["AI review", "Approve source-backed suggestions with confidence scores visible."],
            ].map(([title, detail]) => (
              <div key={title} className="rounded border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">{detail}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    );
  }

  // The portfolio is exactly the Active DPO list, per §4. A staff or
  // external_scoped membership is not a portfolio entry and never appears here
  // — those tenants are not this person's to run.
  const dpoMemberships = session.memberships.filter((m) => m.tier === "active_dpo");
  const tenantIds = dpoMemberships.map((m) => m.tenantId);

  let tenants: TenantRow[] = [];
  let members: MemberRow[] = [];
  let activities: ActivityRiskRow[] = [];
  let aiSuggestions: AiSuggestionRow[] = [];
  let loadError: string | null = null;

  if (tenantIds.length > 0) {
    const supabase = await requestClient();
    // `.in(tenantIds)` narrows to the Active DPO list; RLS narrows again to
    // what this session may read at all. Both have to hold for a row to appear.
    const [tenantResult, memberResult, activityResult, dpiaResult, aiSuggestionResult] = await Promise.all([
      supabase
        .from("tenants")
        .select(TENANT_COLUMNS)
        .in("id", tenantIds),
      supabase
        .from("memberships")
        .select(MEMBER_COLUMNS)
        .in("tenant_id", tenantIds),
      supabase
        .from("processing_activity")
        .select(ACTIVITY_RISK_COLUMNS)
        .in("tenant_id", tenantIds),
      supabase
        .from("dpia")
        .select("processing_activity_id")
        .in("tenant_id", tenantIds),
      supabase
        .from("ai_suggestion")
        .select(AI_SUGGESTION_COLUMNS)
        .in("tenant_id", tenantIds)
        .eq("status", "pending_dpo_review"),
    ]);

    // Surfaced, never swallowed into an empty list. On a compliance dashboard
    // "nothing needs you" and "we could not find out" must not look identical:
    // the first is a reason to close the tab, and a failed query that renders
    // as the first is the most dangerous thing this page could do.
    loadError =
      tenantResult.error?.message ??
      memberResult.error?.message ??
      activityResult.error?.message ??
      dpiaResult.error?.message ??
      aiSuggestionResult.error?.message ??
      null;
    tenants = (tenantResult.data ?? []) as unknown as TenantRow[];
    members = (memberResult.data ?? []) as unknown as MemberRow[];
    const assessedActivityIds = new Set(
      ((dpiaResult.data ?? []) as { processing_activity_id: string }[]).map(
        (row) => row.processing_activity_id
      )
    );
    activities = ((activityResult.data ?? []) as Omit<ActivityRiskRow, "has_dpia">[]).map(
      (activity) => ({
        ...activity,
        has_dpia: assessedActivityIds.has(activity.id),
      })
    );
    aiSuggestions = (aiSuggestionResult.data ?? []) as unknown as AiSuggestionRow[];
  }

  const now = new Date();

  const workspaces = tenants
    .map((tenant) => {
      const tenantMembers = members.filter((m) => m.tenant_id === tenant.id);
      const tenantActivities = activities.filter((a) => a.tenant_id === tenant.id);
      const tenantAiSuggestions = aiSuggestions.filter((s) => s.tenant_id === tenant.id);
      return {
        tenant,
        members: tenantMembers,
        queue: queueFor(tenant, tenantMembers, now, tenantActivities, tenantAiSuggestions),
      };
    })
    // Most urgent workspace first, on the same rule the rows use inside it.
    .sort((a, b) => {
      const first = a.queue[0];
      const second = b.queue[0];
      if (!first && !second) return a.tenant.name.localeCompare(b.tenant.name);
      if (!first) return 1;
      if (!second) return -1;
      return byUrgency(first, second);
    });

  const totalItems = workspaces.reduce((sum, w) => sum + w.queue.length, 0);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500">Portfolio</p>
          <h1 className="mt-1 text-2xl font-semibold">Client dashboard</h1>
          <p className="mt-1 text-sm text-slate-600" data-testid="signed-in-as">
            Signed in as {session.email}
          </p>
          <p className="text-sm text-slate-600" data-testid="workspace-count">
            {dpoMemberships.length} workspace{dpoMemberships.length === 1 ? "" : "s"}
          </p>
        </div>
        <Link
          href="/tenants/new"
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          data-testid="create-tenant"
        >
          New tenant
        </Link>
      </header>

      {loadError ? (
        <section className="py-10" data-testid="portfolio-error">
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>This list could not be loaded, so it is not showing you anything.</strong>
            <p className="mt-1">
              Treat it as unknown rather than as empty — there may be work waiting that this page
              cannot currently see. ({loadError})
            </p>
          </div>
        </section>
      ) : workspaces.length === 0 ? (
        <section className="py-12" data-testid="portfolio-empty">
          <div className="rounded border border-slate-200 bg-slate-50 px-5 py-6">
            <h2 className="text-lg font-semibold">No Active DPO workspaces</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              You are not on the Active DPO list of any workspace. Staff and external scoped
              memberships do not appear here because they are not yours to run.
            </p>
            <Link
              href="/tenants/new"
              className="mt-4 inline-flex rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white"
              data-testid="create-first-tenant"
            >
              Create a tenant
            </Link>
          </div>
        </section>
      ) : (
        <>
          <section className="pt-6">
            <h2 className="text-lg font-semibold">What needs you</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600" data-testid="portfolio-summary">
              {totalItems === 0
                ? `Nothing is waiting across your ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.`
                : `${totalItems} thing${totalItems === 1 ? "" : "s"} across ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}. ` +
                  "Open a workspace to see the underlying source and evidence."}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Dashboard items are deliberately general. Vendor names, software names and source
              excerpts stay inside each tenant.
            </p>
          </section>

          {workspaces.map(({ tenant, members: tenantMembers, queue }) => (
            <WorkspaceCard
              key={tenant.id}
              tenant={tenant}
              members={tenantMembers}
              queue={queue}
              now={now}
            />
          ))}
        </>
      )}
    </main>
  );
}

function WorkspaceCard({
  tenant,
  members,
  queue,
  now,
}: {
  tenant: TenantRow;
  members: MemberRow[];
  queue: QueueItem[];
  now: Date;
}) {
  const fields = taggedFieldsFor(tenant, members, now, LEGAL_BASIS_LABELS[tenant.legal_basis]);
  const summaries = dashboardSummaries(queue);

  return (
    <section
      className="mt-8 rounded-lg border border-slate-200"
      data-testid="workspace-card"
      data-tenant-id={tenant.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 flex-none place-items-center rounded bg-slate-900 text-xs font-semibold text-white">
            {initials(tenant.name)}
          </span>
          <div>
            <h3 className="font-semibold" data-testid="workspace-name">
              <Link href={`/tenants/${tenant.id}`} className="hover:underline">
                {tenant.name}
              </Link>
            </h3>
            <dl className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              {fields.map((field) => (
                <div key={field.label} className="flex items-center gap-1.5" title={field.basis}>
                  <dt className="text-slate-500">{field.label}:</dt>
                  <dd>{field.value ?? "Not recorded"}</dd>
                  <ConfidenceTag confidence={field.confidence} />
                </div>
              ))}
            </dl>
          </div>
        </div>
        {tenant.status !== "active" ? (
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            {tenant.status === "read_only" ? "Read-only" : "Suspended"}
          </span>
        ) : null}
      </header>

      {summaries.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-600">Nothing is waiting on you here.</p>
      ) : (
        <>
          <div className="grid gap-3 px-4 py-4 sm:grid-cols-2" data-testid="dashboard-summary-list">
            {summaries.map((summary) => (
              <div
                key={summary.key}
                className="rounded border border-slate-200 bg-slate-50 p-3 text-sm"
                data-testid="dashboard-summary"
              >
                <p className="font-medium text-slate-900">{summary.title}</p>
                <p className="mt-1 text-slate-600">{summary.detail}</p>
                <Link
                  href={summary.href(tenant.id)}
                  className="mt-3 inline-flex rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800"
                >
                  {summary.action}
                </Link>
              </div>
            ))}
          </div>

          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Portfolio summaries are aggregated. Open the tenant workspace for specific evidence.
          </p>
        </>
      )}
    </section>
  );
}

interface DashboardSummary {
  key: string;
  title: string;
  detail: string;
  action: string;
  href: (tenantId: string) => string;
}

function dashboardSummaries(queue: QueueItem[]): DashboardSummary[] {
  const count = (where: string) => queue.filter((item) => item.where === where).length;
  const governance = count("Governance");
  const assessments = count("Assessments");
  const aiReview = count("AI review");
  const vendorDiscovery = queue.filter(
    (item) => item.where === "AI review" && /suggestion/i.test(item.title)
  ).length;
  const audit = count("Audit");
  const people = count("People");

  return [
    assessments > 0
      ? {
          key: "assessments",
          title: `${assessments} assessment${assessments === 1 ? "" : "s"} need starting`,
          detail: "Review the tenant workspace to decide whether a DPIA should be opened.",
          action: "Start assessment",
          href: (tenantId: string) => `/tenants/${tenantId}`,
        }
      : null,
    aiReview > 0
      ? {
          key: "ai-review",
          title: `${aiReview} AI suggestion${aiReview === 1 ? "" : "s"} need review`,
          detail: vendorDiscovery > 0 ? "New software or vendor signals are waiting." : "Source-backed drafts are waiting.",
          action: "Review suggestions",
          href: (tenantId: string) => `/tenants/${tenantId}/ai-review`,
        }
      : null,
    governance > 0
      ? {
          key: "governance",
          title: `${governance} governance item${governance === 1 ? "" : "s"} need attention`,
          detail: "Review workspace continuity, status or DPO coverage.",
          action: "Open workspace",
          href: (tenantId: string) => `/tenants/${tenantId}`,
        }
      : null,
    audit > 0
      ? {
          key: "audit",
          title: `${audit} audit access item${audit === 1 ? "" : "s"} need review`,
          detail: "Check external access before it expires.",
          action: "Review access",
          href: (tenantId: string) => `/tenants/${tenantId}`,
        }
      : null,
    people > 0
      ? {
          key: "people",
          title: `${people} people item${people === 1 ? "" : "s"} need follow-up`,
          detail: "Check roster or invitation state inside the tenant.",
          action: "Open workspace",
          href: (tenantId: string) => `/tenants/${tenantId}`,
        }
      : null,
  ].filter((summary): summary is DashboardSummary => summary !== null);
}

function ConfidenceTag({ confidence }: { confidence: Confidence }) {
  const tone: Record<Confidence, string> = {
    stated: "border-emerald-300 bg-emerald-50 text-emerald-800",
    inferred: "border-amber-300 bg-amber-50 text-amber-900",
    unknown: "border-slate-300 bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide ${tone[confidence]}`}
      data-testid={`confidence-${confidence}`}
    >
      {confidence}
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
