/**
 * One workspace, in full — the level below the portfolio.
 *
 * Everything on this screen comes from the live schema. There is no incidents,
 * rights or training table yet, so this page does not pretend otherwise: no tab
 * navigation and no stat tiles, because every figure in them would be invented.
 * The queue holds the same governance and DPIA-gap items the portfolio computes,
 * scoped to this workspace.
 *
 * ACCESS
 *
 * `requireMembership(..., { tier: "active_dpo" })` decides whether this page
 * exists for this caller, and every failure becomes the same `notFound()`:
 *
 *   - no such tenant
 *   - a tenant belonging to someone else
 *   - a tenant this person is only staff or an external reviewer in
 *
 * All three are one response. A 403, or a different page for "you're only
 * staff here", would confirm the workspace is real and tell the caller what
 * they would need to reach it — which is a map of other companies' workspaces
 * drawn one request at a time. §4 tier 2 is explicit that staff never see the
 * register or a DPIA; not seeing this screen is the same rule.
 *
 * Underneath, RLS refuses the rows anyway. This check is the second of the two.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { LEGAL_BASIS_LABELS } from "@/lib/legal-basis";
import {
  ACTIVITY_RISK_COLUMNS,
  AI_SUGGESTION_COLUMNS,
  applyOwnerFilter,
  MEMBER_COLUMNS,
  OWNER_FILTERS,
  OWNER_FILTER_LABELS,
  queueFor,
  taggedFieldsFor,
  TENANT_COLUMNS,
  type AiSuggestionRow,
  type ActivityRiskRow,
  type Confidence,
  type MemberRow,
  type OwnerFilter,
  type TenantRow,
} from "@/lib/tenant-queue";

export const dynamic = "force-dynamic";

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { tenantId } = await params;
  const { filter } = await searchParams;

  try {
    await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    // 401 means we do not know who they are — send them to sign in, which is
    // the same response for every tenant id and so reveals nothing. Anything
    // else collapses to "no such page".
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const [tenantResult, memberResult, activityResult, dpiaResult, aiSuggestionResult] = await Promise.all([
    supabase.from("tenants").select(TENANT_COLUMNS).eq("id", tenantId).maybeSingle(),
    supabase.from("memberships").select(MEMBER_COLUMNS).eq("tenant_id", tenantId),
    supabase.from("processing_activity").select(ACTIVITY_RISK_COLUMNS).eq("tenant_id", tenantId),
    supabase.from("dpia").select("processing_activity_id").eq("tenant_id", tenantId),
    supabase
      .from("ai_suggestion")
      .select(AI_SUGGESTION_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "pending_dpo_review"),
  ]);

  // RLS says no even though the membership check said yes: treat it as the
  // absence it is, using the same response as every other refusal.
  if (!tenantResult.data) notFound();

  const tenant = tenantResult.data as unknown as TenantRow;
  const members = (memberResult.data ?? []) as unknown as MemberRow[];
  const assessedActivityIds = new Set(
    ((dpiaResult.data ?? []) as { processing_activity_id: string }[]).map(
      (row) => row.processing_activity_id
    )
  );
  const activities = ((activityResult.data ?? []) as Omit<ActivityRiskRow, "has_dpia">[]).map(
    (activity) => ({
      ...activity,
      has_dpia: assessedActivityIds.has(activity.id),
    })
  );
  const aiSuggestions = (aiSuggestionResult.data ?? []) as unknown as AiSuggestionRow[];
  // Surfaced rather than swallowed. "Nothing needs you" and "we could not find
  // out" must not look the same on a compliance screen.
  const loadError =
    memberResult.error?.message ??
    activityResult.error?.message ??
    dpiaResult.error?.message ??
    aiSuggestionResult.error?.message ??
    null;

  const now = new Date();
  const queue = queueFor(tenant, members, now, activities, aiSuggestions);
  const activeFilter = toFilter(filter);
  const visible = applyOwnerFilter(queue, activeFilter);
  const fields = taggedFieldsFor(tenant, members, now, LEGAL_BASIS_LABELS[tenant.legal_basis]);

  const onYou = queue.filter((i) => i.owner === "you").length;
  const byId = new Map(queue.map((i) => [i.id, i]));
  // Computed from the whole queue, not the filtered view: a dependency between
  // two rows is a fact about the workspace, not about what is on screen now.
  const blocked = queue.filter((i) => i.blockedBy);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/" className="text-sm text-slate-600 hover:underline" data-testid="back-to-portfolio">
        ← Portfolio
      </Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 flex-none place-items-center rounded bg-slate-900 text-sm font-semibold text-white">
            {initials(tenant.name)}
          </span>
          <div>
            <h1 className="text-2xl font-semibold" data-testid="tenant-name">
              {tenant.name}
            </h1>
            <dl
              className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600"
              data-testid="tenant-facts"
            >
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

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <Link
              href={`/tenants/${tenant.id}/intake`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-intake"
            >
              Intake
            </Link>
            <Link
              href={`/tenants/${tenant.id}/vendors`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-vendors"
            >
              Vendors
            </Link>
            <Link
              href={`/tenants/${tenant.id}/software-discovery`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-software-discovery"
            >
              Discovery
            </Link>
            <Link
              href={`/tenants/${tenant.id}/ai-review`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-ai-review"
            >
              AI review
            </Link>
            <Link
              href={`/tenants/${tenant.id}/request-vendor`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="request-vendor"
            >
              Request vendor
            </Link>
            <Link
              href={`/tenants/${tenant.id}/links`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-links"
            >
              Links
            </Link>
            <Link
              href={`/tenants/${tenant.id}/register`}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              data-testid="open-register"
            >
              Register
            </Link>
          </div>
          {tenant.status !== "active" ? (
            <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
              {tenant.status === "read_only" ? "Read-only" : "Suspended"}
            </span>
          ) : null}
        </div>
      </header>

      {loadError ? (
        <section className="py-10" data-testid="tenant-error">
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>This list could not be loaded, so it is not showing you anything.</strong>
            <p className="mt-1">
              Treat it as unknown rather than as empty — there may be work waiting that this page
              cannot currently see. ({loadError})
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="pt-6">
            <h2 className="text-lg font-semibold">What needs you</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600" data-testid="tenant-summary">
              {queue.length === 0
                ? "Nothing is waiting on you here."
                : `${queue.length} thing${queue.length === 1 ? "" : "s"} in motion. ` +
                  `${onYou === 0 ? "None need" : onYou === 1 ? "One needs" : `${onYou} need`} your judgment; the rest sit with people who have been asked.`}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Nothing on this list is a status number — every row is a piece of work with a name
              against it.
            </p>
          </section>

          {queue.length > 0 ? (
            <>
              <div className="mt-5 flex flex-wrap gap-2 text-xs" data-testid="queue-filters">
                {OWNER_FILTERS.map((option) => (
                  <FilterChip
                    key={option}
                    tenantId={tenant.id}
                    option={option}
                    count={
                      option === "everything"
                        ? queue.length
                        : queue.filter((i) => i.owner === option).length
                    }
                    active={activeFilter === option}
                  />
                ))}
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[44rem] border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-[0.68rem] uppercase tracking-wider text-slate-500">
                      <th className="w-[46%] pb-2 font-medium">What</th>
                      <th className="pb-2 font-medium">Where it sits</th>
                      <th className="pb-2 font-medium">Waiting on</th>
                      <th className="pb-2 font-medium">Clock</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr
                        key={item.id}
                        className="border-t border-slate-100 align-top"
                        data-testid="queue-row"
                        data-item-id={item.id}
                      >
                        <td className="py-3 pr-4">
                          <p className="font-medium">{item.title}</p>
                          <p className="mt-0.5 text-slate-600">{item.detail}</p>
                          {item.blockedBy ? (
                            <p
                              className="mt-1 text-xs font-medium text-amber-800"
                              data-testid="blocked-by"
                            >
                              Blocked by: {byId.get(item.blockedBy)?.title ?? "another item"}
                            </p>
                          ) : null}
                        </td>
                        <td className="py-3 pr-4 text-slate-600">{item.where}</td>
                        <td className="py-3 pr-4 text-slate-600">{item.waitingOn}</td>
                        <td
                          className={`py-3 pr-4 tabular-nums ${
                            item.daysLeft !== null && item.daysLeft < 0
                              ? "font-medium text-red-700"
                              : "text-slate-600"
                          }`}
                          data-testid="queue-clock"
                        >
                          {item.clock}
                        </td>
                        <td className="py-3">
                          <span className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700">
                            {item.action}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {visible.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600" data-testid="filter-empty">
                  Nothing in this workspace is {OWNER_FILTER_LABELS[activeFilter].toLowerCase()}.
                </p>
              ) : null}

              <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
                Ordered by what runs out first, not by which area it lives in.
                {blocked.length > 0 ? (
                  <span data-testid="dependency-note">
                    {" "}
                    {blocked.length === 1
                      ? "One row blocks another"
                      : `${blocked.length} rows are blocked`}
                    : &ldquo;{blocked[0].title}&rdquo; cannot move until &ldquo;
                    {byId.get(blocked[0].blockedBy!)?.title}&rdquo; is resolved.
                  </span>
                ) : null}
              </p>
            </>
          ) : (
            <FirstRunActions tenantId={tenant.id} />
          )}
        </>
      )}
    </main>
  );
}

function FirstRunActions({ tenantId }: { tenantId: string }) {
  const actions = [
    {
      href: `/tenants/${tenantId}/intake`,
      label: "Capture intake",
      detail: "Turn a day-to-day description into a reviewable register suggestion.",
      testId: "first-run-intake",
    },
    {
      href: `/tenants/${tenantId}/software-discovery`,
      label: "Upload discovery export",
      detail: "Use accounting or SSO CSV/TSV exports to find likely software processors.",
      testId: "first-run-discovery",
    },
    {
      href: `/tenants/${tenantId}/vendors`,
      label: "Add vendor evidence",
      detail: "Review vendor policy text with source-backed AI notes.",
      testId: "first-run-vendors",
    },
    {
      href: `/tenants/${tenantId}/request-vendor`,
      label: "Request vendor review",
      detail: "Submit a new vendor request without exposing the DPO workspace.",
      testId: "first-run-request-vendor",
    },
    {
      href: `/tenants/${tenantId}/ai-review`,
      label: "Review AI suggestions",
      detail: "Inspect response text, source excerpts and confidence scores.",
      testId: "first-run-ai-review",
    },
    {
      href: `/tenants/${tenantId}/register`,
      label: "Open register",
      detail: "View processing activities once reviewed drafts exist.",
      testId: "first-run-register",
    },
  ];

  return (
    <section className="mt-6" data-testid="first-run-actions">
      <h3 className="text-sm font-semibold text-slate-900">Start work</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {actions.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            data-testid={action.testId}
            className="rounded border border-slate-200 p-4 text-sm hover:border-slate-300 hover:bg-slate-50"
          >
            <span className="font-medium text-slate-900">{action.label}</span>
            <span className="mt-1 block leading-6 text-slate-600">{action.detail}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Unrecognised values fall back to showing everything rather than erroring. */
function toFilter(raw: string | undefined): OwnerFilter {
  return OWNER_FILTERS.includes(raw as OwnerFilter) ? (raw as OwnerFilter) : "everything";
}

function SignInPrompt() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Fractional DPO</h1>
      <p className="mt-4">
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}

function FilterChip({
  tenantId,
  option,
  count,
  active,
}: {
  tenantId: string;
  option: OwnerFilter;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={option === "everything" ? `/tenants/${tenantId}` : `/tenants/${tenantId}?filter=${option}`}
      data-testid={`filter-${option}`}
      aria-current={active ? "true" : undefined}
      className={`rounded-full border px-2.5 py-1 ${
        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700"
      }`}
    >
      {OWNER_FILTER_LABELS[option]} · {count}
    </Link>
  );
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
