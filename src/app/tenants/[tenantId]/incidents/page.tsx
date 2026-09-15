/**
 * The breach register, and the clock (design resume §2.4).
 *
 * Ordered by urgency rather than by date, because the only question this screen
 * answers under pressure is "what runs out first". The copy is careful about
 * one thing throughout: an expired window is not a broken law. Art. 33(1)
 * permits later notification with reasons, and permits none at all where risk
 * is unlikely — so the screen says the window closed and leaves the judgement
 * where it belongs.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { byUrgency, incidentClock, type Clock } from "@/lib/incident-clock";

export const dynamic = "force-dynamic";

interface IncidentRow {
  id: string;
  title: string;
  description: string;
  discovered_at: string;
  authority_deadline: string;
  notifiability: string;
  notifiability_rationale: string | null;
  notified_authority_at: string | null;
  approximate_people_affected: number | null;
  status: string;
}

export default async function IncidentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId } = await params;
  const { error: formError } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const { data, error } = await supabase
    .from("incident")
    .select(
      "id, title, description, discovered_at, authority_deadline, notifiability, notifiability_rationale, notified_authority_at, approximate_people_affected, status"
    )
    .eq("tenant_id", tenantId)
    .order("discovered_at", { ascending: false });

  async function logIncident(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only, so incidents cannot be logged");
    }

    const discoveredAt = String(formData.get("discoveredAt") ?? "").trim();
    if (!discoveredAt) {
      redirect(
        `/tenants/${tenantId}/incidents?error=${encodeURIComponent("When did you become aware of it? That is when the 72 hours start.")}`
      );
    }

    const client = await requestClient();
    const { error: insertError } = await client.from("incident").insert({
      tenant_id: tenantId,
      title: String(formData.get("title") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      discovered_at: new Date(discoveredAt).toISOString(),
      occurred_at: String(formData.get("occurredAt") ?? "").trim()
        ? new Date(String(formData.get("occurredAt"))).toISOString()
        : null,
      approximate_people_affected: Number(formData.get("affected")) || null,
      created_by: current.session.personId,
    });

    if (insertError) throw new Error("That incident could not be logged");
    revalidatePath(`/tenants/${tenantId}/incidents`);
  }

  const incidents = (data ?? []) as unknown as IncidentRow[];
  const withClocks = incidents
    .map((incident) => ({
      incident,
      clock: incidentClock({
        discoveredAt: incident.discovered_at,
        notifiedAuthorityAt: incident.notified_authority_at,
        notifiability: incident.notifiability,
      }),
    }))
    .filter(({ incident }) => incident.status !== "closed")
    .sort((a, b) => byUrgency(a.clock, b.clock));

  const closed = incidents.filter((incident) => incident.status === "closed");

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-workspace"
      >
        ← Workspace
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Incidents</p>
        <h1 className="mt-1 text-2xl font-semibold">Personal data breaches</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="incidents-summary">
          {access.membership.tenantName} ·{" "}
          {withClocks.length === 0
            ? "nothing open"
            : `${withClocks.length} open, most urgent first`}
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Article 33(5) requires every breach to be documented — including the ones you decide not
          to report. The reasoning is the record.
        </p>
      </header>

      {formError ? (
        <p
          className="mt-5 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900"
          data-testid="incident-error"
        >
          {formError}
        </p>
      ) : null}

      {error ? (
        <div
          className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
          data-testid="incidents-error"
        >
          <strong>Incidents could not be loaded.</strong>
          <p className="mt-1">Treat this as unknown rather than none.</p>
        </div>
      ) : withClocks.length === 0 ? (
        <p className="py-8 text-sm text-slate-600" data-testid="incidents-empty">
          Nothing open. A breach logged here starts a 72-hour clock from the moment you became
          aware of it.
        </p>
      ) : (
        <ul className="mt-6 space-y-4" data-testid="incident-list">
          {withClocks.map(({ incident, clock }) => (
            <li
              key={incident.id}
              className="rounded border border-slate-200 p-4"
              data-testid="incident"
              data-clock={clock.state}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <ClockTag clock={clock} />
                  <h2 className="mt-2 font-medium" data-testid="incident-title">
                    {incident.title}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">{incident.description}</p>
                </div>
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Fact label="Became aware">{formatDateTime(incident.discovered_at)}</Fact>
                <Fact label="72 hours ends">{formatDateTime(incident.authority_deadline)}</Fact>
                <Fact label="People affected">
                  {incident.approximate_people_affected ?? (
                    <span className="text-slate-500">Not yet established</span>
                  )}
                </Fact>
                <Fact label="Assessment">
                  {incident.notifiability === "not_assessed" ? (
                    <span className="text-amber-900">Not assessed yet</span>
                  ) : (
                    incident.notifiability.replaceAll("_", " ")
                  )}
                </Fact>
              </dl>

              {incident.notifiability_rationale ? (
                <p
                  className="mt-2 border-l-2 border-slate-300 pl-3 text-sm text-slate-700"
                  data-testid="incident-rationale"
                >
                  {incident.notifiability_rationale}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {access.membership.tenantStatus === "active" ? (
        <section className="mt-10 border-t border-slate-200 pt-6">
          <h2 className="text-lg font-semibold">Log a breach</h2>
          <p className="mt-1 text-sm text-slate-600">
            Log it as soon as you know. You can fill in what happened later — the clock starts from
            when you became aware, so recording that first is the thing that matters.
          </p>
          <form action={logIncident} className="mt-4 space-y-4" data-testid="incident-form">
            <div>
              <label htmlFor="title" className="block text-sm font-medium text-slate-800">
                What happened, in a line
              </label>
              <input
                id="title"
                name="title"
                required
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="incident-title-input"
              />
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-slate-800">
                What you know so far
              </label>
              <textarea
                id="description"
                name="description"
                required
                rows={3}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="incident-description-input"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="discoveredAt" className="block text-sm font-medium text-slate-800">
                  When did you become aware? <span className="text-red-600">*</span>
                </label>
                <input
                  id="discoveredAt"
                  name="discoveredAt"
                  type="datetime-local"
                  required
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  data-testid="incident-discovered-input"
                />
                <p className="mt-1 text-xs text-slate-500">This starts the 72 hours, not the date it happened.</p>
              </div>
              <div>
                <label htmlFor="occurredAt" className="block text-sm font-medium text-slate-800">
                  When did it happen, if known
                </label>
                <input
                  id="occurredAt"
                  name="occurredAt"
                  type="datetime-local"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  data-testid="incident-occurred-input"
                />
              </div>
            </div>
            <div>
              <label htmlFor="affected" className="block text-sm font-medium text-slate-800">
                Roughly how many people
              </label>
              <input
                id="affected"
                name="affected"
                type="number"
                min={0}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="incident-affected-input"
              />
              <p className="mt-1 text-xs text-slate-500">
                Leave blank if you do not know. Blank records as unestablished; zero would read as
                nobody affected, which is a finding.
              </p>
            </div>
            <button
              type="submit"
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
              data-testid="log-incident"
            >
              Log it and start the clock
            </button>
          </form>
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section className="mt-10 border-t border-slate-200 pt-6">
          <h2 className="text-lg font-semibold">Closed</h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-600" data-testid="closed-incidents">
            {closed.map((incident) => (
              <li key={incident.id}>{incident.title}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function ClockTag({ clock }: { clock: Clock }) {
  const tone: Record<Clock["state"], string> = {
    overdue: "border-red-300 bg-red-50 text-red-900",
    due_soon: "border-amber-300 bg-amber-50 text-amber-900",
    running: "border-slate-300 bg-slate-100 text-slate-700",
    notified: "border-emerald-300 bg-emerald-50 text-emerald-800",
    not_notifiable: "border-slate-300 bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs ${tone[clock.state]}`}
      data-testid="incident-clock"
    >
      {clock.label}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
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
