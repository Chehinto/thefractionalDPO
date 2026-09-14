/**
 * Cross-product AI review inbox.
 *
 * Approval here is deliberately a review stamp only. It records that an Active
 * DPO inspected the model output, source excerpt and confidence score; it does
 * not apply the text to the register, DPIA, vendor file or a generated policy.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import type { Confidence } from "@/lib/tenant-queue";

export const dynamic = "force-dynamic";

type SuggestionStatus = "pending_dpo_review" | "approved";

interface SuggestionRow {
  id: string;
  kind: string;
  title: string;
  response_text: string;
  source_excerpt: string;
  source_label: string | null;
  confidence: Confidence;
  confidence_score: number;
  status: SuggestionStatus;
  created_at: string;
  approved_at: string | null;
}

const SUGGESTION_COLUMNS =
  "id, kind, title, response_text, source_excerpt, source_label, confidence, " +
  "confidence_score, status, created_at, approved_at";

export default async function AiReviewPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
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
  const { data, error } = await supabase
    .from("ai_suggestion")
    .select(SUGGESTION_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  async function approveSuggestion(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    const suggestionId = String(formData.get("suggestionId") ?? "");
    const client = await requestClient();
    const { error: approveError } = await client.rpc("approve_ai_suggestion", {
      p_caller_person_id: current.session.personId,
      p_suggestion_id: suggestionId,
    });
    if (approveError) throw new Error(approveError.message);

    revalidatePath(`/tenants/${tenantId}`);
    revalidatePath(`/tenants/${tenantId}/ai-review`);
  }

  const suggestions = (data ?? []) as unknown as SuggestionRow[];
  const pending = suggestions.filter((suggestion) => suggestion.status === "pending_dpo_review");

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-workspace"
      >
        ← Workspace
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">AI review</p>
        <h1 className="mt-1 text-2xl font-semibold">Review AI suggestions</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="ai-review-summary">
          {pending.length === 0
            ? "No AI suggestions are waiting for DPO review."
            : `${pending.length} suggestion${pending.length === 1 ? "" : "s"} waiting for review in ${access.membership.tenantName}.`}
        </p>
      </header>

      {error ? (
        <section className="py-10" data-testid="ai-review-error">
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>AI suggestions could not be loaded.</strong>
            <p className="mt-1">
              Treat this as unknown rather than empty. ({error.message})
            </p>
          </div>
        </section>
      ) : pending.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="ai-review-empty">
          Nothing to review.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200" data-testid="ai-suggestion-list">
          {pending.map((suggestion) => (
            <li
              key={suggestion.id}
              className="py-6"
              data-testid="ai-suggestion"
              data-suggestion-id={suggestion.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-amber-900"
                      data-testid="ai-suggestion-status"
                      data-status={suggestion.status}
                    >
                      Pending DPO review
                    </span>
                    <span className="text-xs uppercase tracking-wide text-slate-500">
                      {formatKind(suggestion.kind)}
                    </span>
                  </div>
                  <h2 className="mt-2 text-lg font-semibold" data-testid="ai-suggestion-title">
                    {suggestion.title}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {suggestion.source_label ?? "Source"} · {formatDate(suggestion.created_at)}
                  </p>
                </div>

                {access.membership.tenantStatus === "active" ? (
                  <form action={approveSuggestion}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <button
                      type="submit"
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                      data-testid="approve-ai-suggestion"
                    >
                      Mark reviewed
                    </button>
                  </form>
                ) : (
                  <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
                    Workspace read-only
                  </span>
                )}
              </div>

              <section className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
                <div>
                  <h3 className="text-sm font-medium text-slate-800">AI response</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700" data-testid="ai-response">
                    {suggestion.response_text}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ConfidenceTag confidence={suggestion.confidence} />
                    <span
                      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-slate-700"
                      data-testid="confidence-score"
                    >
                      {suggestion.confidence_score}/100
                    </span>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium text-slate-800">Cited source</h3>
                  <blockquote
                    className="mt-1 border-l-2 border-slate-300 pl-3 text-sm text-slate-700"
                    data-testid="source-excerpt"
                  >
                    {suggestion.source_excerpt}
                  </blockquote>
                </div>
              </section>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const CONFIDENCE_BASIS: Record<Confidence, string> = {
  stated: "A person said this, or a document states it without needing interpretation.",
  inferred: "Concluded from context. Shown back for review; it cannot silently become stated.",
  unknown: "Not established by any source seen so far. Never filled with a plausible guess.",
};

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
      title={CONFIDENCE_BASIS[confidence]}
    >
      {confidence}
    </span>
  );
}

function formatKind(kind: string): string {
  return kind.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
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
