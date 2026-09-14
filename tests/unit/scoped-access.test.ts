/**
 * Tier 3 external scoped access, against a real database.
 *
 * This is the tier that hands a working credential to someone outside the
 * company, so the assertions here are mostly about what a link CANNOT do:
 * reach a second tenant, outlive its revocation, be replayed against a
 * different purpose, or answer a question it was not sent.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import {
  createScopedAccessToken,
  hashScopedAccessToken,
  scopedAccessExpiry,
} from "@/lib/scoped-access";

let dpo: Actor;
let otherDpo: Actor;
let staff: Actor;
let tenantId: string;
let otherTenantId: string;
let questionnaireId: string;
let questionIds: string[] = [];

/** A stranger holding a link: no session, no membership, just the anon key. */
function strangerClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * A questionnaire the DPO has signed off, with its questions.
 *
 * Questions go in before approval because the schema requires it — a
 * questionnaire with nothing to answer cannot be approved, and therefore cannot
 * be sent.
 */
async function approvedQuestionnaire(
  owner: Actor,
  tenant: string,
  questions: { question: string; why_needed: string }[]
): Promise<{ id: string; questionIds: string[] }> {
  const { data, error } = await owner.client
    .from("vendor_questionnaire")
    .insert({
      tenant_id: tenant,
      vendor_name: "ScreenCo",
      rationale: "Criminal record checks involve Art. 10 data",
      created_by: owner.personId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`questionnaire insert failed: ${error.message}`);
  const id = data!.id as string;

  const { data: inserted, error: questionError } = await owner.client
    .from("vendor_questionnaire_question")
    .insert(
      questions.map((q, index) => ({
        tenant_id: tenant,
        questionnaire_id: id,
        position: index + 1,
        // 0008 requires every AI-authored row to carry the model's certainty.
        confidence_score: 80,
        ...q,
      }))
    )
    .select("id");
  if (questionError) throw new Error(`questions insert failed: ${questionError.message}`);

  const { error: approveError } = await owner.client.rpc("approve_vendor_questionnaire", {
    p_caller_person_id: owner.personId,
    p_questionnaire_id: id,
  });
  if (approveError) throw new Error(`approve failed: ${approveError.message}`);

  return { id, questionIds: (inserted ?? []).map((row) => row.id as string) };
}

async function issue(
  actor: Actor,
  tenant: string,
  overrides: Record<string, unknown> = {}
): Promise<{ token: string; grantId: string | null; error: { message: string } | null }> {
  const { token, tokenHash } = createScopedAccessToken();
  const { data, error } = await actor.client.rpc("issue_scoped_access", {
    p_caller_person_id: actor.personId,
    p_tenant_id: tenant,
    p_purpose: "vendor_questionnaire",
    p_token_hash: tokenHash,
    p_label: "Acme security team",
    p_expires_at: scopedAccessExpiry(),
    p_vendor_questionnaire_id: questionnaireId,
    ...overrides,
  });
  return { token, grantId: (data as { id: string } | null)?.id ?? null, error };
}

beforeAll(async () => {
  dpo = await createActor("scoped-dpo");
  otherDpo = await createActor("scoped-other-dpo");
  staff = await createActor("scoped-staff");
  tenantId = await createTenant(dpo, "Scoped Access Co", "contractual");
  otherTenantId = await createTenant(otherDpo, "Other Scoped Co", "mandatory");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  const questionnaire = await approvedQuestionnaire(dpo, tenantId, [
    {
      question: "How long do you retain candidate results?",
      why_needed: "Art. 30 retention field is unevidenced",
    },
    {
      question: "Do you transfer data outside the UK/EEA?",
      why_needed: "Art. 44 transfer assessment",
    },
  ]);
  questionnaireId = questionnaire.id;
  questionIds = questionnaire.questionIds;
});

describe("issuing a link", () => {
  it("lets the Active DPO issue one and does not return the token hash to them", async () => {
    const { grantId, error } = await issue(dpo, tenantId);

    expect(error).toBeNull();
    expect(grantId).toBeTruthy();

    const { data } = await dpo.client
      .from("scoped_access_grant")
      .select("label, purpose, revoked_at")
      .eq("id", grantId!)
      .single();
    expect(data).toMatchObject({ label: "Acme security team", purpose: "vendor_questionnaire" });

    // token_hash is not in the column grant: a hash that reaches a client is a
    // hash that can be replayed straight into the redeem function.
    const { error: hashError } = await dpo.client
      .from("scoped_access_grant")
      .select("token_hash")
      .eq("id", grantId!)
      .single();
    expect(hashError).not.toBeNull();
  });

  it("refuses a staff member and another tenant's DPO as not found", async () => {
    const asStaff = await issue(staff, tenantId);
    expect(asStaff.error?.message).toContain("not found");

    const asOutsider = await issue(otherDpo, tenantId);
    expect(asOutsider.error?.message).toContain("not found");
  });

  it("refuses to send a questionnaire the DPO has not approved yet", async () => {
    const { data } = await dpo.client
      .from("vendor_questionnaire")
      .insert({
        tenant_id: tenantId,
        vendor_name: "DraftCo",
        rationale: "Still being written",
        created_by: dpo.personId,
      })
      .select("id")
      .single();

    const result = await issue(dpo, tenantId, { p_vendor_questionnaire_id: data!.id });
    expect(result.error?.message).toContain("not approved");
  });

  it("will not issue a link that outlives the ceiling", async () => {
    const tooLong = new Date(Date.now() + 200 * 86_400_000).toISOString();
    const result = await issue(dpo, tenantId, { p_expires_at: tooLong });
    expect(result.error).not.toBeNull();
  });

  it("refuses an auditor link that names a questionnaire", async () => {
    const result = await issue(dpo, tenantId, { p_purpose: "auditor_review" });
    expect(result.error).not.toBeNull();
  });
});

describe("a stranger holding a live link", () => {
  it("can read the questionnaire, and the read is logged", async () => {
    const { token, grantId } = await issue(dpo, tenantId);
    const stranger = strangerClient();

    // An unrelated token is refused as an empty result, not an error: a
    // refusal must look the same whatever caused it.
    const { data: redeemed } = await stranger.rpc("redeem_scoped_access", {
      p_token_hash: createScopedAccessToken().tokenHash,
    });
    expect(redeemed).toEqual([]);

    const { data: ok } = await stranger.rpc("redeem_scoped_access", {
      p_token_hash: hashOf(token),
    });
    expect(ok?.[0]).toMatchObject({ purpose: "vendor_questionnaire", tenant_name: "Scoped Access Co" });

    const { data: questions } = await stranger.rpc("scoped_questionnaire", {
      p_token_hash: hashOf(token),
    });
    expect(questions).toHaveLength(2);
    expect(questions![0]).toMatchObject({ question_position: 1 });

    const { data: events } = await adminClient()
      .from("scoped_access_event")
      .select("kind")
      .eq("grant_id", grantId!);
    expect(events!.map((e) => e.kind)).toContain("viewed");
  });

  it("reaches no table directly, only the three functions", async () => {
    const stranger = strangerClient();

    for (const table of ["scoped_access_grant", "scoped_access_event", "vendor_questionnaire", "processing_activity", "tenants"]) {
      const { data, error } = await stranger.from(table).select("*").limit(1);
      expect(error ?? data).not.toEqual([{ leaked: true }]);
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("can answer a question it was sent, and correcting it does not create a second answer", async () => {
    const { token, grantId } = await issue(dpo, tenantId);
    const stranger = strangerClient();

    await stranger.rpc("submit_scoped_questionnaire_response", {
      p_token_hash: hashOf(token),
      p_question_id: questionIds[0],
      p_answer: "Thirty days after the check completes",
      p_respondent_email: "security@acme.test",
    });
    await stranger.rpc("submit_scoped_questionnaire_response", {
      p_token_hash: hashOf(token),
      p_question_id: questionIds[0],
      p_answer: "Corrected: ninety days",
    });

    const { data } = await adminClient()
      .from("vendor_questionnaire_response")
      .select("answer, scoped_access_grant_id")
      .eq("scoped_access_grant_id", grantId!);

    expect(data).toHaveLength(1);
    expect(data![0]!.answer).toBe("Corrected: ninety days");
  });

  it("cannot answer a question belonging to another questionnaire", async () => {
    const { token } = await issue(dpo, tenantId);
    const foreign = await approvedQuestionnaire(otherDpo, otherTenantId, [
      { question: "Another tenant's question", why_needed: "Should be unreachable" },
    ]);

    const { data } = await strangerClient().rpc("submit_scoped_questionnaire_response", {
      p_token_hash: hashOf(token),
      p_question_id: foreign.questionIds[0],
      p_answer: "Should never land",
    });

    expect(data).toBeNull();

    const { data: landed } = await adminClient()
      .from("vendor_questionnaire_response")
      .select("id")
      .eq("question_id", foreign.questionIds[0]);
    expect(landed).toEqual([]);
  });
});

describe("a link that should no longer work", () => {
  it("stops working the moment it is revoked, and the attempt is logged", async () => {
    const { token, grantId } = await issue(dpo, tenantId);
    const stranger = strangerClient();

    const before = await stranger.rpc("scoped_questionnaire", { p_token_hash: hashOf(token) });
    expect(before.data).toHaveLength(2);

    await dpo.client.rpc("revoke_scoped_access", {
      p_caller_person_id: dpo.personId,
      p_grant_id: grantId!,
    });

    const after = await stranger.rpc("scoped_questionnaire", { p_token_hash: hashOf(token) });
    expect(after.data).toEqual([]);

    const { data: refusals } = await adminClient()
      .from("scoped_access_event")
      .select("kind, detail")
      .eq("grant_id", grantId!)
      .eq("kind", "refused");
    expect(refusals![0]).toMatchObject({ detail: "revoked" });
  });

  it("stops working once expired", async () => {
    const { token, grantId } = await issue(dpo, tenantId);

    // Aged rather than waited out. Both timestamps move, because the table
    // refuses a grant that expires before it was issued — the constraint that
    // stops a link being created already dead.
    const { error: ageError } = await adminClient()
      .from("scoped_access_grant")
      .update({
        issued_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .eq("id", grantId!);
    expect(ageError).toBeNull();

    const { data } = await strangerClient().rpc("redeem_scoped_access", {
      p_token_hash: hashOf(token),
    });
    expect(data).toEqual([]);

    const { data: refusals } = await adminClient()
      .from("scoped_access_event")
      .select("detail")
      .eq("grant_id", grantId!)
      .eq("kind", "refused");
    expect(refusals![0]).toMatchObject({ detail: "expired" });
  });

  it("refuses an unknown token identically, and logs nothing for it", async () => {
    const { data: before } = await adminClient().from("scoped_access_event").select("id");
    const unknown = createScopedAccessToken();

    const { data } = await strangerClient().rpc("redeem_scoped_access", {
      p_token_hash: unknown.tokenHash,
    });
    expect(data).toEqual([]);

    const { data: after } = await adminClient().from("scoped_access_event").select("id");
    expect(after!.length).toBe(before!.length);
  });

  it("refuses a malformed hash the same way, without a decode error", async () => {
    for (const bad of ["", "zzzz", "abc", "../../etc/passwd"]) {
      const { data, error } = await strangerClient().rpc("redeem_scoped_access", {
        p_token_hash: bad,
      });
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });
});

describe("purpose confinement", () => {
  it("refuses a questionnaire token replayed against a link issued for reading", async () => {
    const { token, error } = await issueAuditor();
    expect(error).toBeNull();

    // An auditor link is a valid, live grant — just not for this door.
    const { data: wrongDoor } = await strangerClient().rpc("scoped_questionnaire", {
      p_token_hash: hashOf(token),
    });
    expect(wrongDoor).toEqual([]);

    const { data: wrongWrite } = await strangerClient().rpc(
      "submit_scoped_questionnaire_response",
      { p_token_hash: hashOf(token), p_question_id: questionIds[0], p_answer: "no" }
    );
    expect(wrongWrite).toBeNull();
  });
});

async function issueAuditor() {
  const { token, tokenHash } = createScopedAccessToken();
  const { error } = await dpo.client.rpc("issue_scoped_access", {
    p_caller_person_id: dpo.personId,
    p_tenant_id: tenantId,
    p_purpose: "auditor_review",
    p_token_hash: tokenHash,
    p_label: "External auditor",
    p_expires_at: scopedAccessExpiry(),
    p_vendor_questionnaire_id: null,
  });
  return { token, error };
}

/**
 * Re-derived rather than captured, so each call exercises the path the vendor
 * page will take: a token arrives from a URL and is hashed on the server.
 */
function hashOf(token: string): string {
  return hashScopedAccessToken(token);
}
