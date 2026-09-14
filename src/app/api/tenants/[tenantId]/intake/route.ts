/**
 * Day-to-day intake: "something changed" in plain English.
 *
 * This is the sticky accidental-DPO workflow from the design resume. It does
 * not write the register. It creates a reviewable `register_intake` AI
 * suggestion with source text and confidence scoring, so a DPO can decide what
 * becomes a processing-activity draft later.
 */

import { NextResponse } from "next/server";
import { AiRuntimeError, generateAiSuggestionDraft } from "@/lib/ai-suggestion-runtime";
import {
  buildDayToDayIntakeSuggestionRequest,
  parseDayToDayIntakeRequest,
} from "@/lib/day-to-day-intake";
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
        { error: "This workspace is read-only or suspended, so intake drafts cannot be created" },
        { status: 409 }
      );
    }

    const intake = parseDayToDayIntakeRequest(await request.json().catch(() => ({})));
    const input = buildDayToDayIntakeSuggestionRequest(intake);
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
