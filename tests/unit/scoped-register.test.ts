/**
 * What an auditor link exposes, and what it must not.
 *
 * `scoped_register` is the one path that hands a company's Article 30 record to
 * someone outside it. The interesting assertions are the exclusions: drafts,
 * evidence quotes, confidence tags and people are all deliberately absent, and
 * each of those is a separate way this could leak more than the record itself.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import { seedActivity } from "../support/register-fixtures";
import { createScopedAccessToken, hashScopedAccessToken, scopedAccessExpiry } from "@/lib/scoped-access";

let dpo: Actor;
let tenantId: string;
let otherTenantId: string;
let auditorToken: string;

function strangerClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

async function approvedActivity(tenant: string, seed = {}): Promise<string> {
  const id = await seedActivity(tenant, seed);
  const { error } = await dpo.client.rpc("approve_processing_activity", {
    p_caller_person_id: dpo.personId,
    p_activity_id: id,
  });
  if (error) throw new Error(`approve failed: ${error.message}`);
  return id;
}

async function issueAuditorLink(tenant: string): Promise<string> {
  const { token, tokenHash } = createScopedAccessToken();
  const { error } = await dpo.client.rpc("issue_scoped_access", {
    p_caller_person_id: dpo.personId,
    p_tenant_id: tenant,
    p_purpose: "auditor_review",
    p_token_hash: tokenHash,
    p_label: "External auditor",
    p_expires_at: scopedAccessExpiry(),
    p_vendor_questionnaire_id: null,
  });
  if (error) throw new Error(`issue failed: ${error.message}`);
  return token;
}

beforeAll(async () => {
  dpo = await createActor("scoped-register-dpo");
  tenantId = await createTenant(dpo, "Audited Co", "mandatory");
  otherTenantId = await createTenant(dpo, "Not Audited Co", "voluntary");

  await approvedActivity(tenantId, {
    purpose: "Payroll administration",
    purposeEvidence: "Quoted from the internal payroll contract, page 4",
    retention: "7 years from end of employment",
  });
  await seedActivity(tenantId, { purpose: "A draft nobody approved" });
  await approvedActivity(otherTenantId, { purpose: "Another company's activity" });

  auditorToken = await issueAuditorLink(tenantId);
});

describe("what the register link returns", () => {
  it("shows approved activities from its own tenant only", async () => {
    const { data } = await strangerClient().rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(auditorToken),
    });

    const purposes = (data ?? []).map((row: { purpose: string }) => row.purpose);
    expect(purposes).toContain("Payroll administration");
    expect(purposes).not.toContain("Another company's activity");
  });

  // A draft is the DPO thinking. Disclosing it as part of a register
  // misrepresents what the company has actually recorded.
  it("never shows a draft", async () => {
    const { data } = await strangerClient().rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(auditorToken),
    });

    const purposes = (data ?? []).map((row: { purpose: string }) => row.purpose);
    expect(purposes).not.toContain("A draft nobody approved");
    expect(purposes).toHaveLength(1);
  });

  // Evidence quotes internal contracts and email; confidence tags are this
  // tool's own uncertainty; created_by/approved_by are people. None of those
  // are the Art. 30 record.
  it("returns the record and none of the working state around it", async () => {
    const { data } = await strangerClient().rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(auditorToken),
    });

    const row = (data ?? [])[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "activity_id",
      "approved_at",
      "data_categories_ordinary",
      "data_categories_special",
      "data_subjects",
      "dpia_risk_flag",
      "purpose",
      "recipient_vendor",
      "retention",
      "role",
    ]);
  });
});

describe("what the register link refuses", () => {
  it("refuses a questionnaire link, the same way it refuses an unknown one", async () => {
    // A live grant for a different purpose must not open this door.
    const { data: questionnaireGrant } = await dpo.client
      .from("vendor_questionnaire")
      .insert({
        tenant_id: tenantId,
        vendor_name: "ScreenCo",
        rationale: "Needed for the DPIA",
        created_by: dpo.personId,
      })
      .select("id")
      .single();
    await dpo.client.from("vendor_questionnaire_question").insert({
      tenant_id: tenantId,
      questionnaire_id: questionnaireGrant!.id,
      position: 1,
      question: "How long do you retain data?",
      why_needed: "Retention is unevidenced",
      confidence_score: 80,
    });
    await dpo.client.rpc("approve_vendor_questionnaire", {
      p_caller_person_id: dpo.personId,
      p_questionnaire_id: questionnaireGrant!.id,
    });

    const { token, tokenHash } = createScopedAccessToken();
    await dpo.client.rpc("issue_scoped_access", {
      p_caller_person_id: dpo.personId,
      p_tenant_id: tenantId,
      p_purpose: "vendor_questionnaire",
      p_token_hash: tokenHash,
      p_label: "ScreenCo",
      p_expires_at: scopedAccessExpiry(),
      p_vendor_questionnaire_id: questionnaireGrant!.id,
    });

    const { data } = await strangerClient().rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(token),
    });
    expect(data).toEqual([]);
  });

  it("stops the moment the link is revoked, and records the attempt", async () => {
    const token = await issueAuditorLink(tenantId);
    const stranger = strangerClient();

    const before = await stranger.rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(token),
    });
    expect(before.data).toHaveLength(1);

    const { data: grants } = await adminClient()
      .from("scoped_access_grant")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("purpose", "auditor_review")
      .order("issued_at", { ascending: false });
    const grantId = grants![0]!.id as string;

    await dpo.client.rpc("revoke_scoped_access", {
      p_caller_person_id: dpo.personId,
      p_grant_id: grantId,
    });

    const after = await stranger.rpc("scoped_register", {
      p_token_hash: hashScopedAccessToken(token),
    });
    expect(after.data).toEqual([]);

    const { data: refusals } = await adminClient()
      .from("scoped_access_event")
      .select("detail")
      .eq("grant_id", grantId)
      .eq("kind", "refused");
    expect(refusals![0]).toMatchObject({ detail: "revoked" });
  });
});
