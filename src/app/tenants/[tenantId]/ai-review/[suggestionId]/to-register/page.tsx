/**
 * Turn a reviewed suggestion into a register draft.
 *
 * The step that was missing: detection produced suggestions, a DPO could mark
 * one reviewed, and the Article 30 register stayed empty because approval there
 * is only a stamp. This is the bridge — and it lands a `pending_dpo_review`
 * draft, never an approved row, so `approve_processing_activity` remains the
 * human step. AI output still never reaches a canonical record directly.
 *
 * The form is mostly empty on purpose. What each source actually establishes
 * decides what is prefilled (see `register-promotion.ts`); everything else is
 * left blank with a note saying so, because §9 forbids filling a field with a
 * plausible-sounding guess and a half-filled draft is the exact shape a guess
 * hides in.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import {
  prefillFromSuggestion,
  validateRegisterDraft,
  type SuggestionSource,
} from "@/lib/register-promotion";

export const dynamic = "force-dynamic";

export default async function ToRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; suggestionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { tenantId, suggestionId } = await params;
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
  const { data: suggestion } = await supabase
    .from("ai_suggestion")
    .select(
      "id, kind, title, response_text, source_label, source_excerpt, status, processing_activity_id, vendor_request_id, software_discovery_signal_id"
    )
    .eq("id", suggestionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  // A suggestion from another workspace reads as missing, like everything else.
  if (!suggestion) notFound();

  // Already promoted: show where it went rather than creating a second entry.
  if (suggestion.processing_activity_id) {
    redirect(`/tenants/${tenantId}/register`);
  }

  const [{ data: vendorRequest }, { data: signal }] = await Promise.all([
    suggestion.vendor_request_id
      ? supabase
          .from("vendor_request")
          .select("vendor_name, purpose, data_description")
          .eq("id", suggestion.vendor_request_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    suggestion.software_discovery_signal_id
      ? supabase
          .from("software_discovery_signal")
          .select("software_name, vendor_name, signal_text")
          .eq("id", suggestion.software_discovery_signal_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const source: SuggestionSource = {
    kind: suggestion.kind as string,
    title: suggestion.title as string,
    sourceLabel: (suggestion.source_label as string | null) ?? null,
    sourceExcerpt: suggestion.source_excerpt as string,
    vendorRequest: vendorRequest
      ? {
          vendorName: vendorRequest.vendor_name as string,
          purpose: vendorRequest.purpose as string,
          dataDescription: (vendorRequest.data_description as string | null) ?? null,
        }
      : null,
    discoverySignal: signal
      ? {
          softwareName: signal.software_name as string,
          vendorName: (signal.vendor_name as string | null) ?? null,
          signalText: signal.signal_text as string,
        }
      : null,
  };
  const prefill = prefillFromSuggestion(source);

  async function createDraft(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only, so the register cannot be added to");
    }

    const purpose = String(formData.get("purpose") ?? "").trim();
    const role = String(formData.get("role") ?? "");
    const problem = validateRegisterDraft({ purpose, role });
    if (problem) {
      redirect(
        `/tenants/${tenantId}/ai-review/${suggestionId}/to-register?error=${encodeURIComponent(problem)}`
      );
    }

    const client = await requestClient();
    const { data: created, error: insertError } = await client
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        purpose,
        // The tag travels with the value. A purpose the DPO typed themselves is
        // stated; one carried over from a source keeps whatever that source
        // established, and can never be quietly upgraded.
        purpose_confidence:
          purpose === prefill.purpose && prefill.purposeConfidence !== "unknown"
            ? prefill.purposeConfidence
            : "stated",
        purpose_evidence: prefill.purposeEvidence,
        recipient_vendor: String(formData.get("recipientVendor") ?? "").trim() || null,
        recipient_vendor_confidence: prefill.recipientVendorConfidence,
        recipient_vendor_evidence: prefill.recipientVendorEvidence,
        role,
        data_categories_ordinary: formData.getAll("ordinary").map(String),
        data_categories_special: formData.getAll("special").map(String),
        // The DPO is ticking boxes from what they know right now, not reading it
        // out of a document. Stated, because a person is asserting it.
        data_categories_confidence: "stated",
        data_subjects: formData.getAll("subjects").map(String),
        data_subjects_confidence: "stated",
        retention: String(formData.get("retention") ?? "").trim() || null,
        retention_confidence: String(formData.get("retention") ?? "").trim() ? "stated" : "unknown",
        created_by: current.session.personId,
      })
      .select("id")
      .single();

    if (insertError) throw new Error("That draft could not be created");

    // Link the suggestion to what it became, so the register entry can be traced
    // back to the export line or the colleague's request that started it.
    await client
      .from("ai_suggestion")
      .update({ processing_activity_id: created!.id })
      .eq("id", suggestionId);

    redirect(`/tenants/${tenantId}/register`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}/ai-review`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-ai-review"
      >
        ← AI review
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Add to the register</p>
        <h1 className="mt-1 text-2xl font-semibold" data-testid="promote-title">
          {suggestion.title as string}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {access.membership.tenantName} · lands as a draft for you to approve, not as a record.
        </p>
      </header>

      {formError ? (
        <p
          className="mt-5 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900"
          data-testid="promote-error"
        >
          {formError}
        </p>
      ) : null}

      <section className="mt-5 rounded border border-slate-200 bg-slate-50 px-4 py-3">
        <h2 className="text-sm font-medium">What this is based on</h2>
        <blockquote
          className="mt-1 border-l-2 border-slate-300 pl-3 text-sm text-slate-700"
          data-testid="promote-source"
        >
          {suggestion.source_excerpt as string}
        </blockquote>
        <p className="mt-3 text-sm font-medium text-slate-800">This source does not establish:</p>
        <ul className="mt-1 list-disc pl-5 text-sm text-slate-600" data-testid="promote-unestablished">
          {prefill.unestablished.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </section>

      <form action={createDraft} className="mt-6 space-y-5" data-testid="promote-form">
        <Field label="What is the processing for?" name="purpose" required>
          <textarea
            id="purpose"
            name="purpose"
            required
            rows={3}
            defaultValue={prefill.purpose}
            placeholder="e.g. Screening candidates for regulated roles"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="promote-purpose"
          />
        </Field>

        <Field label="Who receives the data?" name="recipientVendor">
          <input
            id="recipientVendor"
            name="recipientVendor"
            defaultValue={prefill.recipientVendor}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="promote-vendor"
          />
        </Field>

        <Field label="Are you controller or processor here?" name="role" required>
          <select
            id="role"
            name="role"
            required
            defaultValue=""
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="promote-role"
          >
            <option value="" disabled>
              Choose — this one is never inferred
            </option>
            <option value="controller">Controller</option>
            <option value="processor">Processor</option>
          </select>
        </Field>

        <Field label="How long is it kept, and on what basis?" name="retention">
          <input
            id="retention"
            name="retention"
            defaultValue={prefill.retention}
            placeholder="e.g. 12 months from the end of the recruitment round"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="promote-retention"
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank if you do not know yet. It records as unknown, which is a gap to close —
            not a guess.
          </p>
        </Field>

        <button
          type="submit"
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
          data-testid="promote-submit"
        >
          Create register draft
        </button>
      </form>
    </main>
  );
}

function Field({
  label,
  name,
  required,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-800">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      {children}
    </div>
  );
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
