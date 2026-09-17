/**
 * DPO-only software discovery upload.
 *
 * Export files from accounting and SSO tools are only signals. They can reveal
 * likely software use, but they do not prove purpose, categories, transfers or
 * processor status, so each row creates an AI suggestion for DPO review rather
 * than writing to the register.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import { saveAiSuggestion } from "@/lib/save-ai-suggestion";
import {
  buildSoftwareDiscoverySuggestionRequest,
  parseSoftwareDiscoverySpreadsheetUpload,
  type SavedSoftwareDiscoverySignal,
} from "@/lib/software-discovery";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function SoftwareDiscoveryPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ imported?: string }>;
}) {
  const { tenantId } = await params;
  const { imported } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  async function uploadDiscoveryExport(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only or suspended, so discovery uploads cannot be created");
    }

    let signals;
    try {
      signals = await parseSoftwareDiscoverySpreadsheetUpload(formData);
    } catch (e) {
      if (e instanceof AiRuntimeError) throw new Error(e.message);
      throw e;
    }

    const client = await requestClient();
    for (const signal of signals) {
      const { data, error } = await client
        .from("software_discovery_signal")
        .insert({
          tenant_id: tenantId,
          source: signal.source,
          source_name: signal.sourceName,
          external_ref: signal.externalRef,
          software_name: signal.softwareName,
          vendor_name: signal.vendorName,
          signal_text: signal.signalText,
          amount: signal.amount,
          currency: signal.currency,
          occurred_on: signal.occurredOn,
          created_by: current.session.personId,
        })
        .select(
          "id, source, source_name, external_ref, software_name, vendor_name, signal_text, amount, currency, occurred_on"
        )
        .single();

      if (error) throw new Error(error.message);

      const savedSignal: SavedSoftwareDiscoverySignal = {
        id: data!.id as string,
        source: data!.source as SavedSoftwareDiscoverySignal["source"],
        sourceName: data!.source_name as string,
        externalRef: (data!.external_ref as string | null) ?? null,
        softwareName: data!.software_name as string,
        vendorName: (data!.vendor_name as string | null) ?? null,
        signalText: data!.signal_text as string,
        amount: (data!.amount as number | null) ?? null,
        currency: (data!.currency as string | null) ?? null,
        occurredOn: (data!.occurred_on as string | null) ?? null,
      };
      const aiInput = buildSoftwareDiscoverySuggestionRequest(savedSignal);
      const draft = await generateAiSuggestionDraft(aiInput);
      const saved = await saveAiSuggestion({
        tenantId,
        personId: current.session.personId,
        input: aiInput,
        draft,
      });
      if (saved.error) throw new Error(saved.error.message);
    }

    redirect(`/tenants/${tenantId}/software-discovery?imported=${signals.length}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Discovery</p>
        <h1 className="mt-1 text-2xl font-semibold">Upload software signals</h1>
        <p className="mt-1 text-sm text-slate-600">{access.membership.tenantName}</p>
      </header>

      {imported ? (
        <div
          className="mt-6 rounded border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          data-testid="software-discovery-imported"
        >
          {imported} signal{imported === "1" ? "" : "s"} sent for DPO review.
        </div>
      ) : null}

      <form action={uploadDiscoveryExport} className="mt-6 space-y-5" data-testid="software-discovery-form">
        <div>
          <label htmlFor="source" className="block text-sm font-medium text-slate-800">
            Source
          </label>
          <select
            id="source"
            name="source"
            required
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="accounting_subscription">Accounting subscriptions</option>
            <option value="accounting_payment">Accounting payments</option>
            <option value="sso_application">SSO applications</option>
          </select>
        </div>

        <div>
          <label htmlFor="sourceName" className="block text-sm font-medium text-slate-800">
            System
          </label>
          <input
            id="sourceName"
            name="sourceName"
            required
            placeholder="Xero, QuickBooks, Okta, Google Workspace"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="file" className="block text-sm font-medium text-slate-800">
            Export file
          </label>
          <input
            id="file"
            name="file"
            type="file"
            required
            accept=".csv,.tsv,text/csv,text/tab-separated-values"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
          data-testid="submit-software-discovery"
        >
          Send for review
        </button>
      </form>
    </main>
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
