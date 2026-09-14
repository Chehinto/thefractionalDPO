/**
 * Staff-safe new vendor request.
 *
 * Any live member can submit this form, but it does not reveal the register,
 * DPIA, vendor evidence or other people's requests. The request itself is
 * visible to the requester and Active DPOs through RLS; the linked AI
 * suggestion is DPO-only.
 */

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import {
  buildVendorRequestSuggestionRequest,
  parseNewVendorRequestInput,
  type SavedVendorRequest,
} from "@/lib/new-vendor-request";
import { saveAiSuggestion } from "@/lib/save-ai-suggestion";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function RequestVendorPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ submitted?: string }>;
}) {
  const { tenantId } = await params;
  const { submitted } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId);
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  async function requestVendor(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId);
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only or suspended, so vendor requests cannot be created");
    }

    const input = parseNewVendorRequestInput({
      vendorName: formData.get("vendorName"),
      purpose: formData.get("purpose"),
      dataDescription: formData.get("dataDescription"),
    });
    const client = await requestClient();
    const { data, error } = await client
      .from("vendor_request")
      .insert({
        tenant_id: tenantId,
        requester_id: current.session.personId,
        vendor_name: input.vendorName,
        purpose: input.purpose,
        data_description: input.dataDescription,
      })
      .select("id, vendor_name, purpose, data_description")
      .single();

    if (error) throw new Error(error.message);

    const vendorRequest: SavedVendorRequest = {
      id: data!.id as string,
      vendorName: data!.vendor_name as string,
      purpose: data!.purpose as string,
      dataDescription: (data!.data_description as string | null) ?? null,
    };
    const aiInput = buildVendorRequestSuggestionRequest(vendorRequest);
    const draft = await generateAiSuggestionDraft(aiInput);
    const saved = await saveAiSuggestion({
      tenantId,
      personId: current.session.personId,
      input: aiInput,
      draft,
      bypassRlsAfterMembershipCheck: true,
    });
    if (saved.error) throw new Error(saved.error.message);

    redirect(`/tenants/${tenantId}/request-vendor?submitted=1`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Vendor request</p>
        <h1 className="mt-1 text-2xl font-semibold">Request a new vendor review</h1>
        <p className="mt-1 text-sm text-slate-600">{access.membership.tenantName}</p>
      </header>

      {submitted === "1" ? (
        <div
          className="mt-6 rounded border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          data-testid="vendor-request-submitted"
        >
          Your request was sent for DPO review.
        </div>
      ) : null}

      <form action={requestVendor} className="mt-6 space-y-5" data-testid="vendor-request-form">
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
          <label htmlFor="purpose" className="block text-sm font-medium text-slate-800">
            Why do you want to use them?
          </label>
          <textarea
            id="purpose"
            name="purpose"
            required
            rows={4}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="dataDescription" className="block text-sm font-medium text-slate-800">
            What data will they handle?
          </label>
          <textarea
            id="dataDescription"
            name="dataDescription"
            rows={4}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
          data-testid="submit-vendor-request"
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
