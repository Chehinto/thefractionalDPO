/**
 * Seed reviewable AI suggestions.
 *
 * These are direct setup rows for tests. The database trigger still keeps them
 * pending, so tests cannot accidentally bypass the same review discipline the
 * product relies on.
 */

import { adminClient } from "./tenancy-fixtures";

export async function seedAiSuggestion(
  tenantId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("ai_suggestion")
    .insert({
      tenant_id: tenantId,
      kind: "register_intake",
      title: "Review Slack as a likely processor",
      response_text:
        "Slack looks likely to process staff account and message metadata. Confirm purpose, categories and transfer details before adding it to the register.",
      source_excerpt: "SLACK monthly team subscription",
      source_label: "Xero accounting payment signal",
      confidence: "inferred",
      confidence_score: 76,
      model_name: "test-model",
      prompt_key: "test_prompt",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedAiSuggestion failed: ${error.message}`);
  return data!.id as string;
}
