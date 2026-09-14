/**
 * Request review of a new vendor.
 *
 * Any live member may submit their own request, but only the DPO sees the AI
 * review item it creates. This is the staff-safe doorway into the ROPA/vendor
 * workflow: no register read, no DPIA read, no canonical write.
 */

import { NextResponse } from "next/server";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import {
  buildVendorRequestSuggestionRequest,
  parseNewVendorRequestInput,
  type SavedVendorRequest,
} from "@/lib/new-vendor-request";
import {
  messageForAiSuggestionSaveError,
  saveAiSuggestion,
  statusForAiSuggestionSaveError,
} from "@/lib/save-ai-suggestion";
import { errorResponse, requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const access = await requireMembership(tenantId);

    if (access.membership.tenantStatus !== "active") {
      return NextResponse.json(
        { error: "This workspace is read-only or suspended, so vendor requests cannot be created" },
        { status: 409 }
      );
    }

    const input = parseNewVendorRequestInput(await request.json().catch(() => ({})));
    const supabase = await requestClient();
    const { data, error } = await supabase
      .from("vendor_request")
      .insert({
        tenant_id: tenantId,
        requester_id: access.session.personId,
        vendor_name: input.vendorName,
        purpose: input.purpose,
        data_description: input.dataDescription,
      })
      .select("id, vendor_name, purpose, data_description, status")
      .single();

    if (error) {
      return NextResponse.json(
        { error: messageForAiSuggestionSaveError(error.code, "The vendor request could not be saved") },
        { status: statusForAiSuggestionSaveError(error.code) }
      );
    }

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
      personId: access.session.personId,
      input: aiInput,
      draft,
      // Staff are allowed to create the request, but the resulting AI review
      // item is DPO-only. The live membership check above is the authorization
      // boundary before this deliberate RLS bypass.
      bypassRlsAfterMembershipCheck: true,
    });

    if (saved.error) {
      return NextResponse.json(
        { error: messageForAiSuggestionSaveError(saved.error.code) },
        { status: statusForAiSuggestionSaveError(saved.error.code) }
      );
    }

    return NextResponse.json(
      {
        request: data,
        suggestion: saved.data,
        usedFallback: draft.usedFallback,
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof AiRuntimeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof TenantAccessError) return errorResponse(e);
    throw e;
  }
}
