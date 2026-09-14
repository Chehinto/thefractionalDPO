/**
 * ROPA software discovery from integrations.
 *
 * Accounting subscriptions/payments and SSO app assignments are evidence that
 * software is probably in use. They are not enough to create a register row.
 * This route stores the source signals and creates DPO review suggestions.
 */

import { NextResponse } from "next/server";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import {
  buildSoftwareDiscoverySuggestionRequest,
  parseSoftwareDiscoverySpreadsheetUpload,
  parseSoftwareDiscoveryInput,
  type SavedSoftwareDiscoverySignal,
} from "@/lib/software-discovery";
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
    const access = await requireMembership(tenantId, { tier: "active_dpo" });

    if (access.membership.tenantStatus !== "active") {
      return NextResponse.json(
        { error: "This workspace is read-only or suspended, so software discovery cannot be created" },
        { status: 409 }
      );
    }

    const contentType = request.headers.get("content-type") ?? "";
    const signals = contentType.includes("multipart/form-data")
      ? await parseSoftwareDiscoverySpreadsheetUpload(await request.formData())
      : parseSoftwareDiscoveryInput(await request.json().catch(() => ({})));
    const supabase = await requestClient();
    const created: { signalId: string; suggestionId: string | null }[] = [];

    for (const signal of signals) {
      const { data, error } = await supabase
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
          created_by: access.session.personId,
        })
        .select(
          "id, source, source_name, external_ref, software_name, vendor_name, signal_text, amount, currency, occurred_on"
        )
        .single();

      if (error) {
        return NextResponse.json(
          {
            error: messageForAiSuggestionSaveError(
              error.code,
              "The software discovery signal could not be saved"
            ),
          },
          { status: statusForAiSuggestionSaveError(error.code) }
        );
      }

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
        personId: access.session.personId,
        input: aiInput,
        draft,
      });

      if (saved.error) {
        return NextResponse.json(
          { error: messageForAiSuggestionSaveError(saved.error.code) },
          { status: statusForAiSuggestionSaveError(saved.error.code) }
        );
      }
      created.push({ signalId: savedSignal.id, suggestionId: saved.data?.id ?? null });
    }

    return NextResponse.json({ discovered: created }, { status: 201 });
  } catch (e) {
    if (e instanceof AiRuntimeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if (e instanceof TenantAccessError) return errorResponse(e);
    throw e;
  }
}
