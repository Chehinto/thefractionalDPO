/**
 * Create one reviewable AI suggestion for a workspace.
 *
 * The tenant id comes from the URL but is matched against the caller's live
 * Active-DPO membership before any model call happens. The request body cannot
 * widen tenant access; linked record ids are optional context and are enforced
 * again by tenant-aware foreign keys when the suggestion is inserted.
 */

import { NextResponse } from "next/server";
import {
  AiRuntimeError,
  generateAiSuggestionDraft,
  parseAiSuggestionRequest,
} from "@/lib/ai-suggestion-runtime";
import {
  messageForAiSuggestionSaveError,
  saveAiSuggestion,
  statusForAiSuggestionSaveError,
} from "@/lib/save-ai-suggestion";
import { errorResponse, requireMembership, TenantAccessError } from "@/lib/tenant-access";

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
        { error: "This workspace is read-only or suspended, so AI drafts cannot be created" },
        { status: 409 }
      );
    }

    const input = parseAiSuggestionRequest(await request.json().catch(() => ({})));
    const draft = await generateAiSuggestionDraft(input);
    const { data, error } = await saveAiSuggestion({
      tenantId,
      personId: access.session.personId,
      input,
      draft,
    });

    if (error) {
      return NextResponse.json(
        { error: messageForAiSuggestionSaveError(error.code) },
        { status: statusForAiSuggestionSaveError(error.code) }
      );
    }

    return NextResponse.json(
      {
        suggestion: data,
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
