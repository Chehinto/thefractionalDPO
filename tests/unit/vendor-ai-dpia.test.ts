/**
 * AI-assisted vendor DPIA pipeline.
 *
 * This is the evidence layer, not the canonical assessment. The tests assert
 * the shape that lets AI be useful without becoming a silent writer: extracted
 * facts, generated questionnaires and reconciliation proposals all start
 * `pending_dpo_review`, stay tenant-scoped under RLS, and require explicit DPO
 * approval before they can be treated as reviewed evidence.
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
let dpiaId: string;

beforeAll(async () => {
  dpo = await createActor("ai-dpia-dpo");
  otherDpo = await createActor("ai-dpia-other");
  tenantId = await createTenant(dpo, "AI Vendor Co", "mandatory");
  otherTenantId = await createTenant(otherDpo, "Other AI Vendor Co", "contractual");
  activityId = await seedActivity(tenantId, {
    purpose: "Recruitment screening platform",
    recipientVendor: "ScreenCo",
    special: ["criminal_offence_data"],
  });
  dpiaId = await seedDpia();
});

async function seedDpia(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("dpia")
    .insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      likelihood: "medium",
      severity: "high",
      necessity_proportionality: "Screening is needed for regulated roles.",
      residual_likelihood: "low",
      residual_severity: "medium",
      review_due: "2027-09-12",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedDpia failed: ${error.message}`);
  return data!.id as string;
}

async function seedDocument(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_document")
    .insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      vendor_name: "ScreenCo",
      document_type: "privacy_policy",
      title: "ScreenCo Privacy Policy",
      source_url: "https://screenco.example/privacy",
      content:
        "ScreenCo processes candidate identity, employment history and criminal record checks.",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedDocument failed: ${error.message}`);
  return data!.id as string;
}

async function seedFact(
  documentId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_extracted_fact")
    .insert({
      tenant_id: tenantId,
      vendor_document_id: documentId,
      subject: "data_categories",
      label: "Criminal offence checks",
      value: "The vendor processes criminal record check data.",
      confidence: "stated",
      confidence_score: 92,
      evidence: "Privacy policy says ScreenCo processes criminal record checks.",
      source_pages: [1],
      source_char_start: 12,
      source_char_end: 75,
      model_name: "test-model",
      prompt_key: "vendor_policy_extract_v1",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedFact failed: ${error.message}`);
  return data!.id as string;
}

async function seedQuestionnaire(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_questionnaire")
    .insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      dpia_id: dpiaId,
      vendor_name: "ScreenCo",
      rationale:
        "The policy states criminal-record processing but does not explain retention or access controls.",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedQuestionnaire failed: ${error.message}`);
  return data!.id as string;
}

async function seedQuestion(
  questionnaireId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_questionnaire_question")
    .insert({
      tenant_id: tenantId,
      questionnaire_id: questionnaireId,
      position: 1,
      question: "How long do you retain criminal record check data?",
      answer_type: "free_text",
      why_needed: "Retention is not stated in the vendor privacy policy.",
      evidence_gap: "No retention period found.",
      confidence_score: 81,
      source_excerpt: "ScreenCo processes candidate identity and criminal record checks.",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedQuestion failed: ${error.message}`);
  return data!.id as string;
}

async function seedResponse(
  questionnaireId: string,
  questionId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_questionnaire_response")
    .insert({
      tenant_id: tenantId,
      questionnaire_id: questionnaireId,
      question_id: questionId,
      respondent_email: "privacy@screenco.example",
      answer: "We retain criminal record check data for 30 days after completion.",
      evidence: "Vendor questionnaire reply.",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedResponse failed: ${error.message}`);
  return data!.id as string;
}

async function seedReconciliation(
  responseId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("vendor_dpia_reconciliation")
    .insert({
      tenant_id: tenantId,
      dpia_id: dpiaId,
      questionnaire_response_id: responseId,
      target_field: "retention",
      proposed_value: "30 days after criminal record check completion.",
      confidence: "stated",
      confidence_score: 88,
      evidence: "Vendor answered the retention question directly.",
      source_excerpt: "We retain criminal record check data for 30 days after completion.",
      model_name: "test-model",
      prompt_key: "vendor_questionnaire_reconcile_v1",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedReconciliation failed: ${error.message}`);
  return data!.id as string;
}

async function seedGeneratedDocumentDraft(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("generated_document_draft")
    .insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      dpia_id: dpiaId,
      document_type: "privacy_notice",
      title: "ScreenCo candidate privacy notice draft",
      generation_rationale:
        "Generate a reviewable notice from vendor policy evidence and the DPIA context.",
      model_name: "test-model",
      prompt_key: "privacy_notice_generate_v1",
      created_by: dpo.personId,
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedGeneratedDocumentDraft failed: ${error.message}`);
  return data!.id as string;
}

async function seedGeneratedDocumentSection(
  draftId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("generated_document_section")
    .insert({
      tenant_id: tenantId,
      draft_id: draftId,
      position: 1,
      heading: "Data we collect",
      body: "ScreenCo may process identity, employment history and criminal record check data for regulated-role screening.",
      source_excerpt:
        "ScreenCo processes candidate identity, employment history and criminal record checks.",
      source_label: "ScreenCo Privacy Policy",
      confidence: "stated",
      confidence_score: 91,
      model_name: "test-model",
      prompt_key: "privacy_notice_generate_v1",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedGeneratedDocumentSection failed: ${error.message}`);
  return data!.id as string;
}

describe("vendor documents and extracted facts", () => {
  it("keeps vendor documents tenant-scoped and Active-DPO-only", async () => {
    const documentId = await seedDocument();
    const staff = await createActor("ai-dpia-doc-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const ownerRead = await dpo.client.from("vendor_document").select("id").eq("id", documentId);
    const staffRead = await staff.client.from("vendor_document").select("id").eq("id", documentId);
    const otherRead = await otherDpo.client
      .from("vendor_document")
      .select("id")
      .eq("id", documentId);

    expect(ownerRead.data).toEqual([{ id: documentId }]);
    expect(staffRead.data).toEqual([]);
    expect(otherRead.data).toEqual([]);
  });

  it("refuses a document attached to another tenant's processing activity", async () => {
    const { error } = await adminClient()
      .from("vendor_document")
      .insert({
        tenant_id: otherTenantId,
        processing_activity_id: activityId,
        vendor_name: "ScreenCo",
        document_type: "privacy_policy",
        content: "Trying to attach evidence across tenants.",
      });

    expect(error).not.toBeNull();
  });

  it("starts extracted facts as pending and refuses already-approved AI output", async () => {
    const documentId = await seedDocument();
    const factId = await seedFact(documentId);

    const { data } = await adminClient()
      .from("vendor_extracted_fact")
      .select("status, approved_at, approved_by, confidence_score, source_pages, source_char_start, source_char_end")
      .eq("id", factId)
      .single();
    expect(data).toEqual({
      status: "pending_dpo_review",
      approved_at: null,
      approved_by: null,
      confidence_score: 92,
      source_pages: [1],
      source_char_start: 12,
      source_char_end: 75,
    });

    const { error } = await adminClient()
      .from("vendor_extracted_fact")
      .insert({
        tenant_id: tenantId,
        vendor_document_id: documentId,
        subject: "retention",
        label: "Retention",
        value: "30 days",
        confidence: "stated",
        confidence_score: 91,
        evidence: "Document says 30 days.",
        status: "approved",
      });

    expect(error?.code).toBe("42501");
  });

  it("requires extracted facts to carry a numeric confidence score", async () => {
    const documentId = await seedDocument();
    const { error } = await adminClient().from("vendor_extracted_fact").insert({
      tenant_id: tenantId,
      vendor_document_id: documentId,
      subject: "retention",
      label: "Retention",
      value: "30 days",
      confidence: "stated",
      evidence: "Document says 30 days.",
    });

    expect(error).not.toBeNull();
  });

  it("lets the DPO approve an extracted fact without a direct status update", async () => {
    const documentId = await seedDocument();
    const factId = await seedFact(documentId);

    const direct = await dpo.client
      .from("vendor_extracted_fact")
      .update({ status: "approved" })
      .eq("id", factId);
    expect(direct.error).not.toBeNull();

    const approved = await dpo.client.rpc("approve_vendor_extracted_fact", {
      p_caller_person_id: dpo.personId,
      p_fact_id: factId,
    });
    expect(approved.error).toBeNull();

    const { data } = await adminClient()
      .from("vendor_extracted_fact")
      .select("status, approved_by")
      .eq("id", factId)
      .single();
    expect(data).toEqual({ status: "approved", approved_by: dpo.personId });
  });
});

describe("AI usage accounting", () => {
  it("records model usage against the tenant and related evidence", async () => {
    const documentId = await seedDocument();
    const { data, error } = await adminClient()
      .from("ai_call")
      .insert({
        tenant_id: tenantId,
        task: "vendor_document_extraction",
        model: "fast-test-model",
        tier: "fast",
        input_tokens: 1200,
        output_tokens: 300,
        escalated: true,
        ok: false,
        billed_to: "platform",
        vendor_document_id: documentId,
        dpia_id: dpiaId,
      })
      .select("id")
      .single();

    expect(error).toBeNull();

    const visible = await dpo.client
      .from("ai_call")
      .select("task, tier, input_tokens, output_tokens, escalated, ok")
      .eq("id", data!.id);
    expect(visible.data).toEqual([
      {
        task: "vendor_document_extraction",
        tier: "fast",
        input_tokens: 1200,
        output_tokens: 300,
        escalated: true,
        ok: false,
      },
    ]);
  });

  it("does not let a browser client under-report AI usage", async () => {
    const { error } = await dpo.client.from("ai_call").insert({
      tenant_id: tenantId,
      task: "vendor_document_extraction",
      model: "claimed-free-model",
      tier: "fast",
      input_tokens: 0,
      output_tokens: 0,
    });

    expect(error).not.toBeNull();
  });

  it("hides AI usage from staff and other tenants", async () => {
    const documentId = await seedDocument();
    const { data } = await adminClient()
      .from("ai_call")
      .insert({
        tenant_id: tenantId,
        task: "vendor_document_extraction",
        model: "capable-test-model",
        tier: "capable",
        input_tokens: 500,
        output_tokens: 100,
        vendor_document_id: documentId,
      })
      .select("id")
      .single();

    const staff = await createActor("ai-dpia-usage-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const staffRead = await staff.client.from("ai_call").select("id").eq("id", data!.id);
    const otherRead = await otherDpo.client.from("ai_call").select("id").eq("id", data!.id);

    expect(staffRead.data).toEqual([]);
    expect(otherRead.data).toEqual([]);
  });

  it("refuses usage linked to another tenant's evidence", async () => {
    const documentId = await seedDocument();
    const { error } = await adminClient().from("ai_call").insert({
      tenant_id: otherTenantId,
      task: "vendor_document_extraction",
      model: "fast-test-model",
      tier: "fast",
      vendor_document_id: documentId,
    });

    expect(error).not.toBeNull();
  });
});

describe("questionnaire generation and return", () => {
  it("keeps generated questionnaires pending until a DPO approves them", async () => {
    const questionnaireId = await seedQuestionnaire();
    await seedQuestion(questionnaireId);

    const { error } = await adminClient()
      .from("vendor_questionnaire")
      .insert({
        tenant_id: tenantId,
        processing_activity_id: activityId,
        dpia_id: dpiaId,
        vendor_name: "ScreenCo",
        rationale: "Generated and smuggled in as approved.",
        status: "approved",
      });
    expect(error?.code).toBe("42501");

    const approved = await dpo.client.rpc("approve_vendor_questionnaire", {
      p_caller_person_id: dpo.personId,
      p_questionnaire_id: questionnaireId,
    });
    expect(approved.error).toBeNull();

    const { data } = await adminClient()
      .from("vendor_questionnaire")
      .select("status, approved_by")
      .eq("id", questionnaireId)
      .single();
    expect(data).toEqual({ status: "approved", approved_by: dpo.personId });
  });

  it("refuses questionnaire approval when no questions exist", async () => {
    const questionnaireId = await seedQuestionnaire();
    const { error } = await dpo.client.rpc("approve_vendor_questionnaire", {
      p_caller_person_id: dpo.personId,
      p_questionnaire_id: questionnaireId,
    });

    expect(error?.code).toBe("22023");
  });

  it("refuses a question attached to another tenant's questionnaire", async () => {
    const questionnaireId = await seedQuestionnaire();
    const { error } = await adminClient()
      .from("vendor_questionnaire_question")
      .insert({
        tenant_id: otherTenantId,
        questionnaire_id: questionnaireId,
        position: 1,
        question: "Can this cross tenants?",
        why_needed: "It should not.",
        confidence_score: 71,
        source_excerpt: "Cross-tenant evidence should be refused.",
      });

    expect(error).not.toBeNull();
  });

  it("keeps source text and confidence score beside generated questions", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);

    const { data } = await adminClient()
      .from("vendor_questionnaire_question")
      .select("question, confidence_score, source_excerpt")
      .eq("id", questionId)
      .single();

    expect(data).toEqual({
      question: "How long do you retain criminal record check data?",
      confidence_score: 81,
      source_excerpt: "ScreenCo processes candidate identity and criminal record checks.",
    });
  });

  it("refuses generated questions without a confidence score", async () => {
    const questionnaireId = await seedQuestionnaire();
    const { error } = await adminClient()
      .from("vendor_questionnaire_question")
      .insert({
        tenant_id: tenantId,
        questionnaire_id: questionnaireId,
        position: 1,
        question: "How long do you retain the data?",
        why_needed: "Retention is missing.",
        source_excerpt: "The policy names the data but gives no retention period.",
      });

    expect(error).not.toBeNull();
  });

  it("records a returned vendor answer against the exact question", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);

    const { data } = await dpo.client
      .from("vendor_questionnaire_response")
      .select("id, answer")
      .eq("id", responseId);

    expect(data).toEqual([
      {
        id: responseId,
        answer: "We retain criminal record check data for 30 days after completion.",
      },
    ]);
  });

  it("hides questionnaires and responses from staff, other tenants and anonymous callers", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);
    const staff = await createActor("ai-dpia-questionnaire-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const staffQuestionnaire = await staff.client
      .from("vendor_questionnaire")
      .select("id")
      .eq("id", questionnaireId);
    const otherResponse = await otherDpo.client
      .from("vendor_questionnaire_response")
      .select("id")
      .eq("id", responseId);

    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const anonQuestionnaire = await anon
      .from("vendor_questionnaire")
      .select("id")
      .eq("id", questionnaireId);

    expect(staffQuestionnaire.data).toEqual([]);
    expect(otherResponse.data).toEqual([]);
    expect(anonQuestionnaire.data ?? []).toEqual([]);
  });
});

describe("reconciliation drafts", () => {
  it("starts reconciliation pending and refuses already-approved proposals", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);
    const reconciliationId = await seedReconciliation(responseId);

    const { data } = await adminClient()
      .from("vendor_dpia_reconciliation")
      .select("status, approved_at, approved_by")
      .eq("id", reconciliationId)
      .single();
    expect(data).toEqual({
      status: "pending_dpo_review",
      approved_at: null,
      approved_by: null,
    });

    const { error } = await adminClient()
      .from("vendor_dpia_reconciliation")
      .insert({
        tenant_id: tenantId,
        dpia_id: dpiaId,
        questionnaire_response_id: responseId,
        target_field: "retention",
        proposed_value: "30 days",
        confidence: "stated",
        confidence_score: 84,
        evidence: "Vendor replied with 30 days.",
        source_excerpt: "We retain criminal record check data for 30 days.",
        status: "approved",
      });

    expect(error?.code).toBe("42501");
  });

  it("approves a reconciliation draft without mutating the canonical DPIA", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);
    const reconciliationId = await seedReconciliation(responseId);

    const { data: before } = await adminClient()
      .from("dpia")
      .select("mitigations, status")
      .eq("id", dpiaId)
      .single();

    const approved = await dpo.client.rpc("approve_vendor_dpia_reconciliation", {
      p_caller_person_id: dpo.personId,
      p_reconciliation_id: reconciliationId,
    });
    expect(approved.error).toBeNull();

    const { data: draft } = await adminClient()
      .from("vendor_dpia_reconciliation")
      .select("status, approved_by")
      .eq("id", reconciliationId)
      .single();
    const { data: after } = await adminClient()
      .from("dpia")
      .select("mitigations, status")
      .eq("id", dpiaId)
      .single();

    expect(draft).toEqual({ status: "approved", approved_by: dpo.personId });
    expect(after).toEqual(before);
  });

  it("requires a response or extracted fact as the source of the proposal", async () => {
    const { error } = await adminClient()
      .from("vendor_dpia_reconciliation")
      .insert({
        tenant_id: tenantId,
        dpia_id: dpiaId,
        target_field: "retention",
        proposed_value: "30 days",
        confidence: "inferred",
        confidence_score: 60,
        evidence: "No source row.",
        source_excerpt: "No source row.",
      });

    expect(error).not.toBeNull();
  });

  it("refuses reconciliation drafts without source text and confidence score", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);

    const { error } = await adminClient()
      .from("vendor_dpia_reconciliation")
      .insert({
        tenant_id: tenantId,
        dpia_id: dpiaId,
        questionnaire_response_id: responseId,
        target_field: "retention",
        proposed_value: "30 days",
        confidence: "inferred",
        evidence: "",
      });

    expect(error).not.toBeNull();
  });

  it("refuses staff approval and read-only workspace approval", async () => {
    const questionnaireId = await seedQuestionnaire();
    const questionId = await seedQuestion(questionnaireId);
    const responseId = await seedResponse(questionnaireId, questionId);
    const reconciliationId = await seedReconciliation(responseId);
    const staff = await createActor("ai-dpia-reconcile-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const staffAttempt = await staff.client.rpc("approve_vendor_dpia_reconciliation", {
      p_caller_person_id: staff.personId,
      p_reconciliation_id: reconciliationId,
    });
    expect(staffAttempt.error?.code).toBe("P0002");

    const owner = await createActor("ai-dpia-readonly");
    const lapsed = await createTenant(owner, "Read Only AI Pipeline Co", "mandatory");
    const lapsedActivity = await seedActivity(lapsed, { special: ["health_data"] });
    const lapsedDpia = await seedDpia({
      tenant_id: lapsed,
      processing_activity_id: lapsedActivity,
    });
    const lapsedDocument = await seedDocument({
      tenant_id: lapsed,
      processing_activity_id: lapsedActivity,
    });
    const lapsedFact = await seedFact(lapsedDocument, { tenant_id: lapsed });
    const lapsedReconciliation = await seedReconciliation(responseId, {
      tenant_id: lapsed,
      dpia_id: lapsedDpia,
      questionnaire_response_id: null,
      source_fact_id: lapsedFact,
    });
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", lapsed);

    const readonlyAttempt = await owner.client.rpc("approve_vendor_dpia_reconciliation", {
      p_caller_person_id: owner.personId,
      p_reconciliation_id: lapsedReconciliation,
    });
    expect(readonlyAttempt.error?.code).toBe("42501");
  });
});

describe("generated document drafts", () => {
  it("starts generated documents pending and refuses already-approved drafts", async () => {
    const draftId = await seedGeneratedDocumentDraft();

    const { data } = await adminClient()
      .from("generated_document_draft")
      .select("status, approved_at, approved_by")
      .eq("id", draftId)
      .single();
    expect(data).toEqual({
      status: "pending_dpo_review",
      approved_at: null,
      approved_by: null,
    });

    const { error } = await adminClient()
      .from("generated_document_draft")
      .insert({
        tenant_id: tenantId,
        processing_activity_id: activityId,
        dpia_id: dpiaId,
        document_type: "privacy_notice",
        title: "Already approved draft",
        generation_rationale: "Trying to skip review.",
        status: "approved",
      });

    expect(error?.code).toBe("42501");
  });

  it("requires generated sections to keep source text and a confidence score beside the generated text", async () => {
    const draftId = await seedGeneratedDocumentDraft();
    const sectionId = await seedGeneratedDocumentSection(draftId);

    const { data } = await adminClient()
      .from("generated_document_section")
      .select("body, source_excerpt, confidence, confidence_score")
      .eq("id", sectionId)
      .single();

    expect(data).toEqual({
      body: "ScreenCo may process identity, employment history and criminal record check data for regulated-role screening.",
      source_excerpt:
        "ScreenCo processes candidate identity, employment history and criminal record checks.",
      confidence: "stated",
      confidence_score: 91,
    });
  });

  it("refuses generated sections without source text or confidence score", async () => {
    const draftId = await seedGeneratedDocumentDraft();
    const { error } = await adminClient()
      .from("generated_document_section")
      .insert({
        tenant_id: tenantId,
        draft_id: draftId,
        position: 1,
        heading: "Data we collect",
        body: "ScreenCo may process candidate screening data.",
        source_excerpt: "",
        confidence: "inferred",
        confidence_score: 0,
      });

    expect(error).not.toBeNull();
  });

  it("refuses generated documents and sections attached across tenants", async () => {
    const { error: draftError } = await adminClient()
      .from("generated_document_draft")
      .insert({
        tenant_id: otherTenantId,
        processing_activity_id: activityId,
        dpia_id: dpiaId,
        document_type: "privacy_notice",
        title: "Cross tenant draft",
        generation_rationale: "Should not attach to another tenant's records.",
      });
    expect(draftError).not.toBeNull();

    const draftId = await seedGeneratedDocumentDraft();
    const { error: sectionError } = await adminClient()
      .from("generated_document_section")
      .insert({
        tenant_id: otherTenantId,
        draft_id: draftId,
        position: 1,
        heading: "Cross tenant section",
        body: "This should fail.",
        source_excerpt: "This belongs to another tenant.",
        confidence: "inferred",
        confidence_score: 50,
      });
    expect(sectionError).not.toBeNull();
  });

  it("approves only cited generated drafts and does not allow direct status updates", async () => {
    const emptyDraft = await seedGeneratedDocumentDraft();
    const emptyApproval = await dpo.client.rpc("approve_generated_document_draft", {
      p_caller_person_id: dpo.personId,
      p_draft_id: emptyDraft,
    });
    expect(emptyApproval.error?.code).toBe("22023");

    const draftId = await seedGeneratedDocumentDraft({
      title: "Cited ScreenCo privacy notice draft",
    });
    await seedGeneratedDocumentSection(draftId);

    const direct = await dpo.client
      .from("generated_document_draft")
      .update({ status: "approved" })
      .eq("id", draftId);
    expect(direct.error).not.toBeNull();

    const approved = await dpo.client.rpc("approve_generated_document_draft", {
      p_caller_person_id: dpo.personId,
      p_draft_id: draftId,
    });
    expect(approved.error).toBeNull();

    const { data } = await adminClient()
      .from("generated_document_draft")
      .select("status, approved_by")
      .eq("id", draftId)
      .single();
    expect(data).toEqual({ status: "approved", approved_by: dpo.personId });
  });

  it("hides generated document drafts and sections from staff and other tenants", async () => {
    const draftId = await seedGeneratedDocumentDraft();
    const sectionId = await seedGeneratedDocumentSection(draftId);
    const staff = await createActor("ai-generated-document-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const ownerRead = await dpo.client
      .from("generated_document_draft")
      .select("id")
      .eq("id", draftId);
    const staffRead = await staff.client
      .from("generated_document_draft")
      .select("id")
      .eq("id", draftId);
    const otherSectionRead = await otherDpo.client
      .from("generated_document_section")
      .select("id")
      .eq("id", sectionId);

    expect(ownerRead.data).toEqual([{ id: draftId }]);
    expect(staffRead.data).toEqual([]);
    expect(otherSectionRead.data).toEqual([]);
  });
});
