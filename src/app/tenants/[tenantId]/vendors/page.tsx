/**
 * Vendor evidence for DPIA work.
 *
 * The vendor workflow starts with source documents, not conclusions. A pasted
 * policy/T&C/cookie/DPA/security page is stored as tenant-scoped evidence, then
 * the AI runtime creates a `vendor_first_view` review suggestion linked back to
 * that evidence row. Nothing here writes to the DPIA or register.
 */

import { createHash } from "node:crypto";
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import {
  buildVendorFirstViewSuggestionRequest,
  labelForDocumentType,
  parseVendorEvidenceInput,
  VENDOR_DOCUMENT_TYPES,
  type SavedVendorEvidence,
  type VendorDocumentType,
} from "@/lib/vendor-evidence";
import {
  messageForAiSuggestionSaveError,
  saveAiSuggestion,
} from "@/lib/save-ai-suggestion";

export const dynamic = "force-dynamic";

interface VendorDocumentRow {
  id: string;
  vendor_name: string;
  document_type: VendorDocumentType;
  title: string | null;
  source_url: string | null;
  created_at: string;
}

interface VendorFirstViewRow {
  id: string;
  title: string;
  response_text: string;
  source_excerpt: string;
  source_label: string | null;
  confidence: string;
  confidence_score: number;
  vendor_document_id: string | null;
  created_at: string;
}

export default async function VendorsPage({
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
  const [documentResult, firstViewResult] = await Promise.all([
    supabase
      .from("vendor_document")
      .select("id, vendor_name, document_type, title, source_url, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    supabase
      .from("ai_suggestion")
      .select(
        "id, title, response_text, source_excerpt, source_label, confidence, confidence_score, vendor_document_id, created_at"
      )
      .eq("tenant_id", tenantId)
      .eq("kind", "vendor_first_view")
      .eq("status", "pending_dpo_review")
      .order("created_at", { ascending: false }),
  ]);

  const documents = (documentResult.data ?? []) as unknown as VendorDocumentRow[];
  const firstViews = (firstViewResult.data ?? []) as unknown as VendorFirstViewRow[];
  const loadError = documentResult.error?.message ?? firstViewResult.error?.message ?? null;

  async function addVendorEvidence(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only or suspended, so vendor evidence cannot be added");
    }

    const input = parseVendorEvidenceInput({
      vendorName: formData.get("vendorName"),
      documentType: formData.get("documentType"),
      title: formData.get("title"),
      sourceUrl: formData.get("sourceUrl"),
      content: formData.get("content"),
      processingActivityId: formData.get("processingActivityId"),
    });

    const client = await requestClient();
    const { data, error } = await client
      .from("vendor_document")
      .insert({
        tenant_id: tenantId,
        processing_activity_id: input.processingActivityId,
        vendor_name: input.vendorName,
        document_type: input.documentType,
        title: input.title,
        source_url: input.sourceUrl,
        content: input.content,
        content_sha256: sha256(input.content),
        created_by: current.session.personId,
      })
      .select("id, vendor_name, document_type, title, source_url, content")
      .single();

    if (error) throw new Error(error.message);

    const document: SavedVendorEvidence = {
      id: data!.id as string,
      vendorName: data!.vendor_name as string,
      documentType: data!.document_type as VendorDocumentType,
      title: (data!.title as string | null) ?? null,
      sourceUrl: (data!.source_url as string | null) ?? null,
      content: data!.content as string,
    };
    const aiInput = buildVendorFirstViewSuggestionRequest(document);
    const draft = await generateAiSuggestionDraft(aiInput);
    const saved = await saveAiSuggestion({
      tenantId,
      personId: current.session.personId,
      input: aiInput,
      draft,
    });

    if (saved.error) throw new Error(messageForAiSuggestionSaveError(saved.error.code));
    redirect(`/tenants/${tenantId}/vendors`);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-workspace"
      >
        ← Workspace
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Vendors</p>
        <h1 className="mt-1 text-2xl font-semibold">Vendor evidence</h1>
        <p className="mt-1 text-sm text-slate-600">
          {access.membership.tenantName}
        </p>
      </header>

      {loadError ? (
        <section className="py-10" data-testid="vendor-error">
          <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>Vendor evidence could not be loaded.</strong>
            <p className="mt-1">Treat this as unknown rather than empty. ({loadError})</p>
          </div>
        </section>
      ) : (
        <div className="grid gap-8 py-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <section>
            <h2 className="text-lg font-semibold">Pending AI first views</h2>
            {firstViews.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600" data-testid="vendor-first-view-empty">
                No vendor first views are waiting for review.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-200" data-testid="vendor-first-view-list">
                {firstViews.map((view) => (
                  <li key={view.id} className="py-4" data-testid="vendor-first-view">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{view.title}</h3>
                      <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-amber-900">
                        {view.confidence} · {view.confidence_score}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-700">{view.response_text}</p>
                    <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-sm text-slate-600">
                      {view.source_excerpt}
                    </blockquote>
                    {view.source_label ? (
                      <p className="mt-1 text-xs text-slate-500">{view.source_label}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <h2 className="mt-8 text-lg font-semibold">Source documents</h2>
            {documents.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600" data-testid="vendor-document-empty">
                No vendor documents have been added yet.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-200" data-testid="vendor-document-list">
                {documents.map((document) => (
                  <li key={document.id} className="py-3" data-testid="vendor-document">
                    <p className="font-medium">{document.vendor_name}</p>
                    <p className="text-sm text-slate-600">
                      {document.title || labelForDocumentType(document.document_type)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {labelForDocumentType(document.document_type)}
                      {document.source_url ? ` · ${document.source_url}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold">Add evidence</h2>
            <form action={addVendorEvidence} className="mt-3 space-y-4" data-testid="vendor-evidence-form">
              <div>
                <label htmlFor="vendorName" className="block text-sm font-medium text-slate-800">
                  Vendor
                </label>
                <input
                  id="vendorName"
                  name="vendorName"
                  required
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="documentType" className="block text-sm font-medium text-slate-800">
                  Document type
                </label>
                <select
                  id="documentType"
                  name="documentType"
                  defaultValue="privacy_policy"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                >
                  {VENDOR_DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {labelForDocumentType(type)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="title" className="block text-sm font-medium text-slate-800">
                  Title
                </label>
                <input
                  id="title"
                  name="title"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="sourceUrl" className="block text-sm font-medium text-slate-800">
                  Source URL
                </label>
                <input
                  id="sourceUrl"
                  name="sourceUrl"
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="content" className="block text-sm font-medium text-slate-800">
                  Document text
                </label>
                <textarea
                  id="content"
                  name="content"
                  required
                  rows={10}
                  className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
                data-testid="add-vendor-evidence"
              >
                Add and generate first view
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
