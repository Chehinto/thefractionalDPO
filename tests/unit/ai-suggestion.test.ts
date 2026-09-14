/**
 * Cross-product AI suggestions.
 *
 * This is the generic review rail for AI assistance that is not already owned
 * by a more specific draft table. The important invariant is the same as the
 * vendor/DPIA pipeline: model output is reviewable evidence, not a silent write
 * into the register, DPIA, policy or governance record.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import { seedActivity } from "../support/register-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let tenantId: string;
let otherTenantId: string;
let activityId: string;

beforeAll(async () => {
  dpo = await createActor("ai-suggestion-dpo");
  otherDpo = await createActor("ai-suggestion-other");
  tenantId = await createTenant(dpo, "AI Everywhere Co", "mandatory");
  otherTenantId = await createTenant(otherDpo, "Other AI Everywhere Co", "contractual");
  activityId = await seedActivity(tenantId, {
    purpose: "Employee analytics",
    special: ["health_data"],
  });
});

async function seedSuggestion(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("ai_suggestion")
    .insert({
      tenant_id: tenantId,
      kind: "dpia_mitigation",
      title: "Limit analytics access",
      response_text:
        "Restrict employee analytics output to HR leadership and aggregate dashboards where possible.",
      source_excerpt:
        "The activity processes employee health data for analytics and manager reporting.",
      source_label: "Processing activity",
      confidence: "inferred",
      confidence_score: 82,
      processing_activity_id: activityId,
      model_name: "test-model",
      prompt_key: "dpia_mitigation_suggest_v1",
      created_by: dpo.personId,
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedSuggestion failed: ${error.message}`);
  return data!.id as string;
}

describe("database shape", () => {
  it("stores the AI response beside source text and confidence", async () => {
    const id = await seedSuggestion();

    const { data } = await adminClient()
      .from("ai_suggestion")
      .select("kind, response_text, source_excerpt, confidence, confidence_score, status")
      .eq("id", id)
      .single();

    expect(data).toEqual({
      kind: "dpia_mitigation",
      response_text:
        "Restrict employee analytics output to HR leadership and aggregate dashboards where possible.",
      source_excerpt:
        "The activity processes employee health data for analytics and manager reporting.",
      confidence: "inferred",
      confidence_score: 82,
      status: "pending_dpo_review",
    });
  });

  it("refuses suggestions without source text or a positive confidence score", async () => {
    const { error } = await adminClient().from("ai_suggestion").insert({
      tenant_id: tenantId,
      kind: "governance_next_action",
      title: "Invite a backup DPO",
      response_text: "A second Active DPO would reduce handover risk.",
      source_excerpt: "",
      confidence: "inferred",
      confidence_score: 0,
    });

    expect(error).not.toBeNull();
  });

  it("refuses suggestions attached to another tenant's records", async () => {
    const { error } = await adminClient().from("ai_suggestion").insert({
      tenant_id: otherTenantId,
      kind: "register_reconciliation",
      title: "Cross-tenant suggestion",
      response_text: "This should not attach to another tenant's activity.",
      source_excerpt: "Foreign activity excerpt.",
      confidence: "inferred",
      confidence_score: 70,
      processing_activity_id: activityId,
    });

    expect(error).not.toBeNull();
  });
});

describe("review discipline", () => {
  it("refuses already-approved suggestions, even from the service role", async () => {
    const { error } = await adminClient().from("ai_suggestion").insert({
      tenant_id: tenantId,
      kind: "governance_next_action",
      title: "Already approved",
      response_text: "Trying to skip review.",
      source_excerpt: "A source exists, but review was skipped.",
      confidence: "stated",
      confidence_score: 90,
      status: "approved",
    });

    expect(error?.code).toBe("42501");
  });

  it("does not let a DPO write approval columns directly", async () => {
    const id = await seedSuggestion();

    const { error } = await dpo.client
      .from("ai_suggestion")
      .update({ status: "approved", approved_by: dpo.personId })
      .eq("id", id);

    expect(error).not.toBeNull();

    const { data } = await adminClient()
      .from("ai_suggestion")
      .select("status, approved_by")
      .eq("id", id)
      .single();
    expect(data).toEqual({ status: "pending_dpo_review", approved_by: null });
  });

  it("lets the Active DPO approve a suggestion as a review stamp only", async () => {
    const id = await seedSuggestion();

    const approved = await dpo.client.rpc("approve_ai_suggestion", {
      p_caller_person_id: dpo.personId,
      p_suggestion_id: id,
    });
    expect(approved.error).toBeNull();

    const { data: suggestion } = await adminClient()
      .from("ai_suggestion")
      .select("status, approved_by")
      .eq("id", id)
      .single();
    const { data: activity } = await adminClient()
      .from("processing_activity")
      .select("status")
      .eq("id", activityId)
      .single();

    expect(suggestion).toEqual({ status: "approved", approved_by: dpo.personId });
    expect(activity).toEqual({ status: "pending_dpo_review" });
  });

  it("refuses staff approval and read-only workspace approval", async () => {
    const id = await seedSuggestion();
    const staff = await createActor("ai-suggestion-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const staffAttempt = await staff.client.rpc("approve_ai_suggestion", {
      p_caller_person_id: staff.personId,
      p_suggestion_id: id,
    });
    expect(staffAttempt.error?.code).toBe("P0002");

    const owner = await createActor("ai-suggestion-readonly");
    const lapsed = await createTenant(owner, "Read Only AI Suggestion Co", "mandatory");
    const lapsedSuggestion = await seedSuggestion({ tenant_id: lapsed, processing_activity_id: null });
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", lapsed);

    const readonlyAttempt = await owner.client.rpc("approve_ai_suggestion", {
      p_caller_person_id: owner.personId,
      p_suggestion_id: lapsedSuggestion,
    });
    expect(readonlyAttempt.error?.code).toBe("42501");
  });
});

describe("usage accounting", () => {
  it("can attribute a model call to the suggestion it produced", async () => {
    const id = await seedSuggestion();
    const { data, error } = await adminClient()
      .from("ai_call")
      .insert({
        tenant_id: tenantId,
        task: "ai_suggestion_generation",
        model: "local-ai-suggestion-fallback",
        tier: "fast",
        input_tokens: 40,
        output_tokens: 20,
        ai_suggestion_id: id,
      })
      .select("id")
      .single();

    expect(error).toBeNull();

    const visible = await dpo.client
      .from("ai_call")
      .select("task, ai_suggestion_id")
      .eq("id", data!.id);
    expect(visible.data).toEqual([
      {
        task: "ai_suggestion_generation",
        ai_suggestion_id: id,
      },
    ]);
  });

  it("refuses usage attributed to another tenant's suggestion", async () => {
    const id = await seedSuggestion();
    const { error } = await adminClient().from("ai_call").insert({
      tenant_id: otherTenantId,
      task: "ai_suggestion_generation",
      model: "local-ai-suggestion-fallback",
      tier: "fast",
      ai_suggestion_id: id,
    });

    expect(error).not.toBeNull();
  });
});

describe("RLS", () => {
  it("shows suggestions only to the Active DPO", async () => {
    const id = await seedSuggestion();
    const staff = await createActor("ai-suggestion-read-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const ownerRead = await dpo.client.from("ai_suggestion").select("id").eq("id", id);
    const staffRead = await staff.client.from("ai_suggestion").select("id").eq("id", id);
    const otherRead = await otherDpo.client.from("ai_suggestion").select("id").eq("id", id);
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const anonRead = await anon.from("ai_suggestion").select("id").eq("id", id);

    expect(ownerRead.data).toEqual([{ id }]);
    expect(staffRead.data).toEqual([]);
    expect(otherRead.data).toEqual([]);
    expect(anonRead.data ?? []).toEqual([]);
  });
});
