/**
 * One workspace, in full — the level below the portfolio.
 *
 * Everything on this screen comes from the live schema. There is no register,
 * DPIA, incidents, rights or training table yet, so this page does not pretend
 * otherwise: no tab navigation and no stat tiles, because every figure in them
 * would be invented. The queue holds the same four governance-derived items the
 * portfolio computes, scoped to this workspace.
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
  applyOwnerFilter,
  MEMBER_COLUMNS,
  OWNER_FILTERS,
  OWNER_FILTER_LABELS,
  queueFor,
  taggedFieldsFor,
  TENANT_COLUMNS,
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
  searchParams: Promise<{ view?: string; filter?: string }>;
}) {
  const { tenantId } = await params;
  const { view, filter } = await searchParams;
  const employeePreview = view === "employee";

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
  const [tenantResult, memberResult] = await Promise.all([
    supabase.from("tenants").select(TENANT_COLUMNS).eq("id", tenantId).maybeSingle(),
    supabase.from("memberships").select(MEMBER_COLUMNS).eq("tenant_id", tenantId),
  ]);

  // RLS says no even though the membership check said yes: treat it as the
  // absence it is, using the same response as every other refusal.
  if (!tenantResult.data) notFound();

  const tenant = tenantResult.data as unknown as TenantRow;
  const members = (memberResult.data ?? []) as unknown as MemberRow[];
  // Surfaced rather than swallowed. "Nothing needs you" and "we could not find
  // out" must not look the same on a compliance screen.
  const loadError = memberResult.error?.message ?? null;

  const now = new Date();
  const queue = queueFor(tenant, members, now);
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
            {employeePreview ? null : (
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
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {employeePreview ? null : (
              <Link
                href={`/tenants/${tenant.id}/register`}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                data-testid="open-register"
              >
                Register
              </Link>
            )}
            <ViewToggle tenantId={tenant.id} employeePreview={employeePreview} />
          </div>
          {tenant.status !== "active" && !employeePreview ? (
            <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
              {tenant.status === "read_only" ? "Read-only" : "Suspended"}
            </span>
          ) : null}
        </div>
      </header>

      {employeePreview ? (
        <EmployeePreview />
      ) : loadError ? (
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
          ) : null}
        </>
      )}
    </main>
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

/**
 * The toggle, on the same terms as the portfolio's.
 *
 * Two server-rendered links reading a URL parameter. No client state, no second
 * query, and it can only ever render less of what this session already loaded.
 * It is not an access switch: a staff member does not reach this page by
 * removing it — they never got past `requireMembership` in the first place.
 *
 * The one difference from the portfolio: the workspace NAME stays visible here.
 * The portfolio hides names in employee view because the list of companies a
 * DPO advises is itself the thing being previewed away. On this page the caller
 * is already an Active DPO of this one workspace, and a staff member of it
 * would plainly see its name, so hiding it would make the preview less honest
 * rather than more careful. Everything that is actually DPO work — the queue,
 * the facts panel, the status badge — is gone.
 */
function ViewToggle({ tenantId, employeePreview }: { tenantId: string; employeePreview: boolean }) {
  const base = "rounded px-3 py-1.5 text-sm border";
  const on = "bg-slate-900 text-white border-slate-900";
  const off = "bg-white text-slate-700 border-slate-300";
  return (
    <div className="flex items-center gap-2" role="group" aria-label="Preview">
      <Link
        href={`/tenants/${tenantId}`}
        data-testid="view-dpo"
        aria-current={!employeePreview ? "true" : undefined}
        className={`${base} ${employeePreview ? off : on}`}
      >
        DPO view
      </Link>
      <Link
        href={`/tenants/${tenantId}?view=employee`}
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
 * No publishing or assignment mechanism exists, so the honest preview is empty,
 * and it is empty because there is no query behind this component at all rather
 * than because something was fetched and filtered. There is nothing in the
 * response for a parameter to reveal.
 */
function EmployeePreview() {
  return (
    <section className="py-10" data-testid="employee-preview">
      <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Preview only.</strong> This shows the shape of a staff member&rsquo;s screen in this
        workspace. It is not a way to view anyone&rsquo;s actual scoped items, and it grants
        nothing.
      </div>

      <div className="mt-6 rounded border border-slate-200 px-4 py-8 text-center">
        <p className="text-slate-700">Nothing has been assigned to you.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
          A staff member sees only what has been published or assigned to them specifically — a
          policy to acknowledge, a training module, one scoped question. Never the register, never a
          DPIA, never another member&rsquo;s work.
        </p>
      </div>
    </section>
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
