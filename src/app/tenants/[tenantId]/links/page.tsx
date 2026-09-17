/**
 * Tier-3 links the DPO has issued (design resume §4).
 *
 * Three things on one screen, because they are one decision: what is currently
 * outstanding, what each link has been used for, and the ability to take it
 * back. The view log is not a nice-to-have — §4 asks for it specifically, and
 * refusals are recorded as well as successes, so "they kept trying this a month
 * after we revoked it" is visible rather than inferred from silence.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { DEFAULT_SCOPED_ACCESS_DAYS, MAX_SCOPED_ACCESS_DAYS } from "@/lib/scoped-access";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { IssueLinkForm } from "./issue-link-form";

export const dynamic = "force-dynamic";

interface GrantRow {
  id: string;
  label: string;
  purpose: string;
  vendor_questionnaire_id: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface EventRow {
  grant_id: string;
  kind: "viewed" | "answered" | "refused";
  detail: string | null;
  occurred_at: string;
}

type GrantState = "live" | "revoked" | "expired";

function stateOf(grant: GrantRow): GrantState {
  if (grant.revoked_at) return "revoked";
  if (Date.parse(grant.expires_at) <= Date.now()) return "expired";
  return "live";
}

export default async function LinksPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();

  // token_hash is deliberately absent from this select: it is not in the
  // column grant, and a hash that reaches a page can be replayed.
  const [{ data: grantRows, error }, { data: eventRows }, { data: questionnaireRows }] =
    await Promise.all([
      supabase
        .from("scoped_access_grant")
        .select("id, label, purpose, vendor_questionnaire_id, issued_at, expires_at, revoked_at")
        .eq("tenant_id", tenantId)
        .order("issued_at", { ascending: false }),
      supabase
        .from("scoped_access_event")
        .select("grant_id, kind, detail, occurred_at")
        .eq("tenant_id", tenantId)
        .order("occurred_at", { ascending: false }),
      supabase
        .from("vendor_questionnaire")
        .select("id, vendor_name")
        .eq("tenant_id", tenantId)
        .eq("status", "approved")
        .order("created_at", { ascending: false }),
    ]);

  async function revokeLink(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    const client = await requestClient();
    const { error: revokeError } = await client.rpc("revoke_scoped_access", {
      p_caller_person_id: current.session.personId,
      p_grant_id: String(formData.get("grantId") ?? ""),
    });
    if (revokeError) throw new Error("The link could not be revoked");

    revalidatePath(`/tenants/${tenantId}/links`);
  }

  const grants = (grantRows ?? []) as unknown as GrantRow[];
  const events = (eventRows ?? []) as unknown as EventRow[];
  const questionnaires = (questionnaireRows ?? []).map((row) => ({
    id: row.id as string,
    vendorName: row.vendor_name as string,
  }));

  const eventsByGrant = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = eventsByGrant.get(event.grant_id) ?? [];
    list.push(event);
    eventsByGrant.set(event.grant_id, list);
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Shared links</p>
        <h1 className="mt-1 text-2xl font-semibold">Links you have issued</h1>
        <p className="mt-1 text-sm text-slate-600">
          {access.membership.tenantName} · a link is the whole credential, so it expires by
          default and can be taken back at any time.
        </p>
      </header>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Send a questionnaire</h2>
        {access.membership.tenantStatus === "active" ? (
          <IssueLinkForm
            tenantId={tenantId}
            questionnaires={questionnaires}
            defaultDays={DEFAULT_SCOPED_ACCESS_DAYS}
            maxDays={MAX_SCOPED_ACCESS_DAYS}
          />
        ) : (
          <p className="mt-3 text-sm text-amber-900" data-testid="links-read-only">
            This workspace is read-only, so new links cannot be issued. Existing links can still be
            revoked.
          </p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Outstanding and past links</h2>

        {error ? (
          <div
            className="mt-3 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
            data-testid="links-error"
          >
            <strong>Links could not be loaded.</strong>
            <p className="mt-1">Treat this as unknown rather than none.</p>
          </div>
        ) : grants.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600" data-testid="links-empty">
            No links have been issued for this workspace.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200" data-testid="link-list">
            {grants.map((grant) => {
              const state = stateOf(grant);
              const log = eventsByGrant.get(grant.id) ?? [];
              return (
                <li key={grant.id} className="py-5" data-testid="link-row" data-state={state}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StateTag state={state} />
                        <span className="text-xs uppercase tracking-wide text-slate-500">
                          {grant.purpose.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="mt-2 font-medium" data-testid="link-label">
                        {grant.label}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        Issued {formatDate(grant.issued_at)} ·{" "}
                        {state === "revoked"
                          ? `revoked ${formatDate(grant.revoked_at!)}`
                          : `${state === "expired" ? "expired" : "expires"} ${formatDate(grant.expires_at)}`}
                      </p>
                    </div>

                    {state === "live" ? (
                      <form action={revokeLink}>
                        <input type="hidden" name="grantId" value={grant.id} />
                        <button
                          type="submit"
                          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800"
                          data-testid="revoke-link"
                        >
                          Revoke
                        </button>
                      </form>
                    ) : null}
                  </div>

                  <div className="mt-3" data-testid="link-log">
                    {log.length === 0 ? (
                      <p className="text-sm text-slate-500" data-testid="link-log-empty">
                        Not opened yet.
                      </p>
                    ) : (
                      <ul className="space-y-1 text-sm text-slate-600">
                        {log.slice(0, 8).map((event, index) => (
                          <li key={`${event.occurred_at}-${index}`} data-testid="link-log-entry">
                            <span data-testid="link-log-kind">{describe(event)}</span>{" "}
                            <span className="text-slate-400">{formatDateTime(event.occurred_at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function describe(event: EventRow): string {
  if (event.kind === "viewed") return "Opened";
  if (event.kind === "answered") return "Answered a question";
  return `Refused — ${event.detail ?? "no longer valid"}`;
}

function StateTag({ state }: { state: GrantState }) {
  const tone: Record<GrantState, string> = {
    live: "border-emerald-300 bg-emerald-50 text-emerald-800",
    revoked: "border-red-300 bg-red-50 text-red-900",
    expired: "border-slate-300 bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide ${tone[state]}`}
      data-testid={`link-state-${state}`}
    >
      {state}
    </span>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
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
