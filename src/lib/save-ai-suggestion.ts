import "server-only";

import type { AiSuggestionDraft, AiSuggestionRequest } from "./ai-suggestion-runtime";
import { requestClient, serviceClient } from "./supabase-server";

interface SaveAiSuggestionInput {
  tenantId: string;
  personId: string;
  input: AiSuggestionRequest;
  draft: AiSuggestionDraft;
  bypassRlsAfterMembershipCheck?: boolean;
}

interface SaveAiSuggestionResult {
  data: { id: string; status: string } | null;
  error: { code?: string; message: string } | null;
}

/**
 * Persist one reviewable AI suggestion and attribute the model call that made it.
 *
 * Shared by the generic AI route and product-specific intake flows. Keeping the
 * usage write next to the draft write makes it much harder for a later feature
 * to create AI work without an audit/cost trail.
 */
export async function saveAiSuggestion({
  tenantId,
  personId,
  input,
  draft,
  bypassRlsAfterMembershipCheck = false,
}: SaveAiSuggestionInput): Promise<SaveAiSuggestionResult> {
  const supabase = bypassRlsAfterMembershipCheck ? serviceClient() : await requestClient();

  // The usage row is written before the suggestion, not after. Written after, a
  // failed usage insert threw once the suggestion already existed: the caller
  // saw a 500, retried, and produced a second suggestion for one piece of work.
  // Recording first fails closed — nothing has been written yet — and still
  // refuses to let AI work happen with no cost and attribution trail.
  const callId = await recordAiCall({
    tenantId,
    model: draft.model,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
  });

  const { data, error } = await supabase
    .from("ai_suggestion")
    .insert({
      tenant_id: tenantId,
      kind: input.kind,
      title: draft.title,
      response_text: draft.responseText,
      source_excerpt: draft.sourceExcerpt,
      source_label: draft.sourceLabel,
      confidence: draft.confidence,
      confidence_score: draft.confidenceScore,
      processing_activity_id: input.processingActivityId,
      dpia_id: input.dpiaId,
      vendor_document_id: input.vendorDocumentId,
      vendor_questionnaire_id: input.vendorQuestionnaireId,
      vendor_questionnaire_response_id: input.vendorQuestionnaireResponseId,
      vendor_request_id: input.vendorRequestId,
      software_discovery_signal_id: input.softwareDiscoverySignalId,
      generated_document_draft_id: input.generatedDocumentDraftId,
      model_name: draft.model,
      prompt_key: draft.promptKey,
      created_by: personId,
    })
    .select("id, status")
    .single();

  await linkAiCall(callId, (data?.id as string | undefined) ?? null, !error);

  return {
    data: data ? { id: data.id as string, status: data.status as string } : null,
    error: error ? { code: error.code, message: error.message } : null,
  };
}

async function recordAiCall({
  tenantId,
  model,
  inputTokens,
  outputTokens,
}: {
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<string> {
  const { data, error } = await serviceClient()
    .from("ai_call")
    .insert({
      tenant_id: tenantId,
      task: "ai_suggestion_generation",
      model,
      tier: model.includes("fallback") ? "fast" : "capable",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      // The draft already exists by the time this runs, so generation itself
      // succeeded. `linkAiCall` flips this if the suggestion fails to persist.
      ok: true,
      billed_to: "platform",
    })
    .select("id")
    .single();

  // Still fatal, but now fatal before anything else is written: no suggestion
  // exists yet, so the caller's retry starts from a clean state.
  if (error) {
    throw new Error(`Could not record AI usage: ${error.message}`);
  }

  return data!.id as string;
}

/**
 * Attach the saved suggestion to its usage row and record whether it persisted.
 *
 * Deliberately does not throw. The cost and attribution row already exists; only
 * its link to the suggestion is missing. Throwing here would reintroduce exactly
 * the duplicate-on-retry failure the write ordering above exists to prevent.
 */
async function linkAiCall(callId: string, suggestionId: string | null, ok: boolean) {
  const { error } = await serviceClient()
    .from("ai_call")
    .update({ ai_suggestion_id: suggestionId, ok })
    .eq("id", callId);

  if (error) {
    console.error(`Could not link AI usage ${callId} to its suggestion: ${error.message}`);
  }
}

export function statusForAiSuggestionSaveError(code: string | undefined): number {
  if (code === "23503") return 404;
  if (code === "42501") return 409;
  return 400;
}

/**
 * `fallback` names the row the caller was writing. The mapped codes are shared
 * across every write in this pipeline: 23503 is a foreign key pointing at
 * another tenant's row, which must read as "Not found" rather than confirming
 * the row exists, and 42501 is RLS refusing a read-only workspace.
 */
export function messageForAiSuggestionSaveError(
  code: string | undefined,
  fallback = "The AI suggestion could not be saved"
): string {
  if (code === "23503") return "Not found";
  if (code === "42501") return "This workspace cannot be written to";
  return fallback;
}
