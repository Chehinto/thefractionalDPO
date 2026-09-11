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
 * WHAT IS IN THE QUEUE, AND WHAT IS NOT
 *
 * The register, DPIAs, incidents and rights requests are not built. The queue
 * is therefore built from the governance facts the tenancy layer already holds
 * — an expiring external grant, a read-only workspace counting down to purge, a
 * sole Active DPO with no successor, a rostered colleague who never signed in.
 * These are real deadlines against real rows, not placeholders. Register and
 * DPIA items become additional `QueueItem`s in the same list when those tables
 * exist; nothing about the ordering or the dependency logic changes.
 *
 * The queue rules live in `@/lib/tenant-queue`, shared with the single-tenant
 * view. Only the presentation is here.
 *
 * THE VIEW TOGGLE
 *
 * "Employee view" is a preview and nothing else. It is a URL parameter read on
 * the server, it triggers no additional query, and it can only ever render LESS
 * of what this DPO session already loaded. It is not an access switch: a staff
 * member does not become a DPO by removing it, and a DPO does not see
 * tier-2-scoped data by adding it. See `renderEmployeePreview` below.
 */

import Link from "next/link";
import { requireSession, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { LEGAL_BASIS_LABELS } from "@/lib/legal-basis";
import {
  byUrgency,
  MEMBER_COLUMNS,
  queueFor,
  taggedFieldsFor,
  TENANT_COLUMNS,
  type Confidence,
  type MemberRow,
  type Owner,
  type QueueItem,
  type TenantRow,
} from "@/lib/tenant-queue";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const employeePreview = view === "employee";

  let session = null;
  try {
    session = await requireSession();
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
  }

  if (!session) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-2xl font-semibold">Fractional DPO</h1>
        <p className="mt-4 flex gap-4">
          <Link href="/login" className="underline">
            Sign in
          </Link>
          <Link href="/signup" className="underline">
            Create an account
          </Link>
        </p>
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
  let loadError: string | null = null;

  if (tenantIds.length > 0) {
    const supabase = await requestClient();
    // `.in(tenantIds)` narrows to the Active DPO list; RLS narrows again to
    // what this session may read at all. Both have to hold for a row to appear.
    const [tenantResult, memberResult] = await Promise.all([
      supabase
        .from("tenants")
        .select(TENANT_COLUMNS)
        .in("id", tenantIds),
      supabase
        .from("memberships")
        .select(MEMBER_COLUMNS)
        .in("tenant_id", tenantIds),
    ]);

    // Surfaced, never swallowed into an empty list. On a compliance dashboard
    // "nothing needs you" and "we could not find out" must not look identical:
    // the first is a reason to close the tab, and a failed query that renders
    // as the first is the most dangerous thing this page could do.
    loadError = tenantResult.error?.message ?? memberResult.error?.message ?? null;
    tenants = (tenantResult.data ?? []) as unknown as TenantRow[];
    members = (memberResult.data ?? []) as unknown as MemberRow[];
  }

  const now = new Date();

  const workspaces = tenants
    .map((tenant) => {
      const tenantMembers = members.filter((m) => m.tenant_id === tenant.id);
      return { tenant, members: tenantMembers, queue: queueFor(tenant, tenantMembers, now) };
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
          <h1 className="mt-1 text-2xl font-semibold">Your workspaces</h1>
          <p className="mt-1 text-sm text-slate-600" data-testid="signed-in-as">
            Signed in as {session.email}
          </p>
          <p className="text-sm text-slate-600" data-testid="workspace-count">
            {dpoMemberships.length} workspace{dpoMemberships.length === 1 ? "" : "s"}
          </p>
        </div>
        <ViewToggle employeePreview={employeePreview} />
      </header>

      {employeePreview ? (
        <EmployeePreview workspaceCount={dpoMemberships.length} />
      ) : loadError ? (
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
          <p className="text-slate-700">
            You are not on the Active DPO list of any workspace.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Being a staff member somewhere does not put that company here — the portfolio is the
            list of workspaces you are the professional of record for.
          </p>
        </section>
      ) : (
        <>
          <section className="pt-6">
            <h2 className="text-lg font-semibold">What needs you</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600" data-testid="portfolio-summary">
              {totalItems === 0
                ? `Nothing is waiting across your ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.`
                : `${totalItems} thing${totalItems === 1 ? "" : "s"} across ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}. ` +
                  `${countBy(workspaces, "you")} need your judgment; the rest sit with people who have been asked.`}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Nothing on this list is a status number — every row is a piece of work with a name
              against it.
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

function countBy(
  workspaces: { queue: QueueItem[] }[],
  owner: Owner
): number {
  return workspaces.reduce((sum, w) => sum + w.queue.filter((i) => i.owner === owner).length, 0);
}

/**
 * The toggle.
 *
 * Two links, not a control with state. Switching view is a server render of the
 * SAME data this session already had — there is no second fetch to make, and
 * nothing scoped to a staff member is loaded in either mode, so there is
 * nothing for the parameter to reveal.
 */
function ViewToggle({ employeePreview }: { employeePreview: boolean }) {
  const base = "rounded px-3 py-1.5 text-sm border";
  const on = "bg-slate-900 text-white border-slate-900";
  const off = "bg-white text-slate-700 border-slate-300";
  return (
    <div className="flex items-center gap-2" role="group" aria-label="Preview">
      <Link
        href="/"
        data-testid="view-dpo"
        aria-current={!employeePreview ? "true" : undefined}
        className={`${base} ${employeePreview ? off : on}`}
      >
        DPO view
      </Link>
      <Link
        href="/?view=employee"
        data-testid="view-employee"
        aria-current={employeePreview ? "true" : undefined}
        className={`${base} ${employeePreview ? on : off}`}
      >
        Employee view
      </Link>
    </div>
  );
}

/**
 * What a tier-2 staff member's screen looks like — rendered from nothing.
 *
 * §4 tier 2 sees "whatever's been specifically published or assigned to them".
 * No publishing or assignment mechanism exists yet, so the honest preview is
 * empty. Crucially it is empty because it renders nothing, not because
 * something was fetched and filtered: there is no query behind this component
 * at all, so there is no scoped data present in the response to leak, and no
 * way to widen it with a parameter.
 */
function EmployeePreview({ workspaceCount }: { workspaceCount: number }) {
  return (
    <section className="py-10" data-testid="employee-preview">
      <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Preview only.</strong> This shows the shape of a staff member&rsquo;s screen. It is
        not a way to view anyone&rsquo;s actual scoped items, and it grants nothing.
      </div>

      <div className="mt-6 rounded border border-slate-200 px-4 py-8 text-center">
        <p className="text-slate-700">Nothing has been assigned to you.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          A staff member sees only what has been published or assigned to them specifically — a
          policy to acknowledge, a training module, one scoped question. Never the register, never a
          DPIA, never another member&rsquo;s work.
        </p>
      </div>

      <p className="mt-4 text-sm text-slate-500" data-testid="employee-preview-note">
        Your {workspaceCount} workspace{workspaceCount === 1 ? "" : "s"} and everything in{" "}
        {workspaceCount === 1 ? "it" : "them"} stay hidden in this view.
      </p>
    </section>
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

  const blocked = queue.filter((i) => i.blockedBy);
  const byId = new Map(queue.map((i) => [i.id, i]));

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

      {queue.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-600">Nothing is waiting on you here.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 px-4 pt-4 text-xs" data-testid="queue-filters">
            <Chip label="Everything" count={queue.length} />
            <Chip label="On you" count={queue.filter((i) => i.owner === "you").length} />
            <Chip
              label="With the company"
              count={queue.filter((i) => i.owner === "company").length}
            />
            <Chip label="Outside" count={queue.filter((i) => i.owner === "outside").length} />
          </div>

          <div className="overflow-x-auto px-4 pb-2 pt-3">
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
                {queue.map((item) => (
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
                        <p className="mt-1 text-xs font-medium text-amber-800" data-testid="blocked-by">
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

          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Ordered by what runs out first, not by which area it lives in.
            {blocked.length > 0 ? (
              <span data-testid="dependency-note">
                {" "}
                {blocked.length === 1 ? "One row blocks another" : `${blocked.length} rows are blocked`}
                : &ldquo;{blocked[0].title}&rdquo; cannot move until &ldquo;
                {byId.get(blocked[0].blockedBy!)?.title}&rdquo; is resolved.
              </span>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

function Chip({ label, count }: { label: string; count: number }) {
  return (
    <span className="rounded-full border border-slate-300 px-2.5 py-1 text-slate-700">
      {label} · {count}
    </span>
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
