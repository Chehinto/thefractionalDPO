/**
 * The register: every processing activity recorded for one workspace.
 *
 * Deliberately minimal. There is no creation form — intake (Prompt A batch
 * extraction, Prompt B reconciliation, the day-to-day elicitation prompt) is a
 * separate, unbuilt piece, and a hand-rolled form now would be thrown away when
 * it arrives. Rows are seeded by direct insert until then.
 *
 * WHO CAN OPEN THIS
 *
 * Any member of the workspace, and then RLS decides what they see:
 *
 *   active_dpo  — the whole register, with an approve action on each draft.
 *   staff       — only the activities specifically shared with them (§4 tier 2),
 *                 and no approve action.
 *   non-member  — notFound(), the same response as a workspace that does not
 *                 exist, matching every other tenant-scoped route.
 *
 * The route deliberately does NOT re-implement "staff see only their shares" —
 * that rule lives in the policy on `processing_activity`, so a bug here shows
 * up as too little data rather than too much. Note this is looser than the
 * workspace overview page, which is active_dpo only: a staff member has no
 * business on the DPO's dashboard, but does have business seeing the one
 * activity somebody asked them about.
 *
 * CONFIDENCE IS SHOWN, NOT HIDDEN
 *
 * Every tagged field renders its tag next to the value. A DPO is about to put
 * their name to this record; a field that looks identical whether a person
 * stated it or a model guessed it is the thing that makes the register
 * untrustworthy. `unknown` renders as "Not established" rather than being left
 * blank, because a blank reads as "nothing to say here" and an unknown is a gap
 * somebody has to close.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import type { Confidence } from "@/lib/tenant-queue";

export const dynamic = "force-dynamic";

type ActivityStatus = "pending_dpo_review" | "approved";

interface ActivityRow {
  id: string;
  tenant_id: string;
  status: ActivityStatus;
  purpose: string;
  purpose_confidence: Confidence;
  purpose_evidence: string | null;
  recipient_vendor: string | null;
  recipient_vendor_confidence: Confidence;
  recipient_vendor_evidence: string | null;
  role: "controller" | "processor";
  data_categories_ordinary: string[];
  data_categories_special: string[];
  data_categories_confidence: Confidence;
  data_subjects: string[];
  data_subjects_confidence: Confidence;
  retention: string | null;
  retention_confidence: Confidence;
  dpia_risk_flag: boolean;
  approved_at: string | null;
}

const ACTIVITY_COLUMNS =
  "id, tenant_id, status, purpose, purpose_confidence, purpose_evidence, " +
  "recipient_vendor, recipient_vendor_confidence, recipient_vendor_evidence, role, " +
  "data_categories_ordinary, data_categories_special, data_categories_confidence, " +
  "data_subjects, data_subjects_confidence, retention, retention_confidence, " +
  "dpia_risk_flag, approved_at";

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  let access;
  try {
    access = await requireMembership(tenantId);
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) {
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
    notFound();
  }

  const isDpo = access.membership.tier === "active_dpo";

  const supabase = await requestClient();
  const { data, error } = await supabase
    .from("processing_activity")
    .select(ACTIVITY_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  const activities = (data ?? []) as unknown as ActivityRow[];

  /**
   * Approve one activity.
   *
   * The tenant id is NOT taken from the form. It is read back from the session's
   * membership list inside `approve_processing_activity`, which also refuses a
   * `caller_person_id` that disagrees with the session. A form field naming a
   * tenant would be a client-supplied tenant id by another route.
   */
  async function approve(formData: FormData) {
    "use server";

    const activityId = String(formData.get("activityId") ?? "");
    const session = await requireMembership(tenantId, { tier: "active_dpo" });

    const client = await requestClient();
    const { error: approveError } = await client.rpc("approve_processing_activity", {
      p_caller_person_id: session.session.personId,
      p_activity_id: activityId,
    });
    if (approveError) throw new Error(approveError.message);

    revalidatePath(`/tenants/${tenantId}/register`);
  }

  const pending = activities.filter((a) => a.status === "pending_dpo_review").length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <h1 className="text-2xl font-semibold">Register</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="register-summary">
          {activities.length === 0
            ? isDpo
              ? "No processing activities recorded yet."
              : "Nothing in this register has been shared with you."
            : `${activities.length} activit${activities.length === 1 ? "y" : "ies"}` +
              (isDpo ? `, ${pending} awaiting your review.` : ", shared with you.")}
        </p>
        {!isDpo && activities.length > 0 ? (
          <p className="mt-1 text-sm text-slate-500" data-testid="shared-only-note">
            You are seeing only what has been shared with you specifically, not the register.
          </p>
        ) : null}
      </header>

      {error ? (
        <section className="py-10" data-testid="register-error">
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>This register could not be loaded, so it is not showing you anything.</strong>
            <p className="mt-1">
              Treat it as unknown rather than as empty. ({error.message})
            </p>
          </div>
        </section>
      ) : activities.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="register-empty">
          Nothing to show.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200" data-testid="activity-list">
          {activities.map((activity) => (
            <li key={activity.id} className="py-5" data-testid="activity" data-activity-id={activity.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={activity.status} />
                    {activity.dpia_risk_flag ? (
                      <span
                        className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-red-800"
                        data-testid="dpia-flag"
                        title="Special-category data present. One Art. 35 trigger among several — not a completed DPIA screen."
                      >
                        Special category
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 font-medium" data-testid="activity-purpose">
                    {activity.purpose}{" "}
                    <ConfidenceTag confidence={activity.purpose_confidence} field="purpose" />
                  </p>
                </div>

                {isDpo && activity.status === "pending_dpo_review" ? (
                  <form action={approve}>
                    <input type="hidden" name="activityId" value={activity.id} />
                    <button
                      type="submit"
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                      data-testid="approve-button"
                    >
                      Approve
                    </button>
                  </form>
                ) : null}
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Field
                  label="Recipient / vendor"
                  value={activity.recipient_vendor}
                  confidence={activity.recipient_vendor_confidence}
                  field="recipient_vendor"
                  emptyMeans="First-party — no recipient"
                />
                <div>
                  <dt className="text-slate-500">Role</dt>
                  {/* No confidence tag: §9 records role as always asserted. */}
                  <dd className="capitalize" data-testid="activity-role">
                    {activity.role}
                  </dd>
                </div>
                <Field
                  label="Data categories"
                  value={formatCategories(activity)}
                  confidence={activity.data_categories_confidence}
                  field="data_categories"
                />
                <Field
                  label="Data subjects"
                  value={formatList(activity.data_subjects)}
                  confidence={activity.data_subjects_confidence}
                  field="data_subjects"
                />
                <Field
                  label="Retention"
                  value={activity.retention}
                  confidence={activity.retention_confidence}
                  field="retention"
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * One tagged field.
 *
 * An `unknown` value renders as "Not established" rather than as a blank. A
 * blank reads as "nothing to say here"; an unknown is a gap in an Art. 30
 * record that somebody has to go and close, and the two must not look alike.
 */
function Field({
  label,
  value,
  confidence,
  field,
  emptyMeans,
}: {
  label: string;
  value: string | null;
  confidence: Confidence;
  field: string;
  emptyMeans?: string;
}) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <span className={value ? "" : "text-slate-500"}>
          {value ?? (confidence === "unknown" ? "Not established" : (emptyMeans ?? "—"))}
        </span>
        <ConfidenceTag confidence={confidence} field={field} />
      </dd>
    </div>
  );
}

const CONFIDENCE_BASIS: Record<Confidence, string> = {
  stated: "A person said this, or a document states it without needing interpretation.",
  inferred: "Concluded from context. Shown back for review; it cannot silently become stated.",
  unknown: "Not established by any source seen so far. Never filled with a plausible guess.",
};

function ConfidenceTag({ confidence, field }: { confidence: Confidence; field: string }) {
  const tone: Record<Confidence, string> = {
    stated: "border-emerald-300 bg-emerald-50 text-emerald-800",
    inferred: "border-amber-300 bg-amber-50 text-amber-900",
    unknown: "border-slate-300 bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide ${tone[confidence]}`}
      data-testid={`confidence-${confidence}`}
      data-field={field}
      title={CONFIDENCE_BASIS[confidence]}
    >
      {confidence}
    </span>
  );
}

function StatusBadge({ status }: { status: ActivityStatus }) {
  const approved = status === "approved";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        approved ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"
      }`}
      data-testid="activity-status"
      data-status={status}
    >
      {approved ? "Approved" : "Pending DPO review"}
    </span>
  );
}

function formatList(values: string[]): string | null {
  if (!values?.length) return null;
  return values.map((v) => v.replaceAll("_", " ")).join(", ");
}

/**
 * Special categories are named separately rather than merged into one list.
 * Which categories are special is the whole reason the DPIA flag exists, so
 * flattening them into a single sentence would bury the fact that matters.
 */
function formatCategories(activity: ActivityRow): string | null {
  const ordinary = formatList(activity.data_categories_ordinary);
  const special = formatList(activity.data_categories_special);
  if (!ordinary && !special) return null;
  if (!special) return ordinary;
  return [ordinary, `special: ${special}`].filter(Boolean).join(" · ");
}
