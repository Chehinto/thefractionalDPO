/**
 * DPIAs: who can see them, what the database derives, and how they get signed.
 *
 * Like the register suite, this talks to real Postgres with RLS on. A DPIA is
 * the DPO's recorded judgment, not a staff assignment, so the policy is tighter
 * than `processing_activity`: Active DPOs only, with approval through the
 * explicit function that stamps who signed it and when.
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
  dpo = await createActor("dpia-dpo");
  otherDpo = await createActor("dpia-other");
  tenantId = await createTenant(dpo, "DPIA Co", "mandatory");
  otherTenantId = await createTenant(otherDpo, "Other DPIA Co", "contractual");
  activityId = await seedActivity(tenantId, {
    purpose: "Occupational health assessment",
    special: ["health_data"],
  });
});

async function seedDpia(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await adminClient()
    .from("dpia")
    .insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      likelihood: "medium",
      severity: "high",
      necessity_proportionality:
        "Health assessment is needed before assigning safety-critical work.",
      mitigations: "Limit access to HR and occupational health provider.",
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

describe("database shape", () => {
  it("derives initial risk, residual risk and the prior-consultation trigger", async () => {
    const id = await seedDpia({
      likelihood: "high",
      severity: "medium",
      residual_likelihood: "high",
      residual_severity: "high",
    });

    const { data } = await adminClient()
      .from("dpia")
      .select("initial_risk, residual_risk, requires_prior_consultation")
      .eq("id", id)
      .single();

    expect(data).toEqual({
      initial_risk: "high",
      residual_risk: "high",
      requires_prior_consultation: true,
    });
  });

  it("keeps prior consultation unknown until residual risk is assessed", async () => {
    const id = await seedDpia({ residual_likelihood: null, residual_severity: null });

    const { data } = await adminClient()
      .from("dpia")
      .select("residual_risk, requires_prior_consultation")
      .eq("id", id)
      .single();

    expect(data).toEqual({ residual_risk: null, requires_prior_consultation: null });
  });

  it("refuses a DPIA attached to another tenant's activity", async () => {
    const { error } = await adminClient()
      .from("dpia")
      .insert({
        tenant_id: otherTenantId,
        processing_activity_id: activityId,
        likelihood: "low",
        severity: "low",
        necessity_proportionality: "Trying to cross the streams.",
      });

    expect(error).not.toBeNull();
  });

  it("requires necessity and proportionality reasoning", async () => {
    const { error } = await adminClient()
      .from("dpia")
      .insert({
        tenant_id: tenantId,
        processing_activity_id: activityId,
        likelihood: "low",
        severity: "medium",
        necessity_proportionality: "   ",
      });

    expect(error).not.toBeNull();
  });
});

describe("nothing arrives approved", () => {
  it("defaults a new DPIA to pending_dpo_review", async () => {
    const id = await seedDpia();
    const { data } = await adminClient()
      .from("dpia")
      .select("status, approved_at, approved_by")
      .eq("id", id)
      .single();

    expect(data).toEqual({
      status: "pending_dpo_review",
      approved_at: null,
      approved_by: null,
    });
  });

  it("refuses an insert that arrives approved, even from the service role", async () => {
    const { error } = await adminClient()
      .from("dpia")
      .insert({
        tenant_id: tenantId,
        processing_activity_id: activityId,
        status: "approved",
        likelihood: "low",
        severity: "medium",
        necessity_proportionality: "Already signed without a signer.",
        residual_likelihood: "low",
        residual_severity: "low",
        review_due: "2027-09-12",
      });

    expect(error?.code).toBe("42501");
  });

  it("does not let a DPO write the approval columns directly", async () => {
    const id = await seedDpia();

    const { error } = await dpo.client
      .from("dpia")
      .update({ status: "approved", approved_by: dpo.personId })
      .eq("id", id);

    expect(error).not.toBeNull();

    const { data } = await adminClient().from("dpia").select("status").eq("id", id).single();
    expect(data!.status).toBe("pending_dpo_review");
  });
});

describe("RLS", () => {
  it("shows a DPIA to the Active DPO", async () => {
    const id = await seedDpia();
    const { data } = await dpo.client.from("dpia").select("id").eq("id", id);
    expect(data).toEqual([{ id }]);
  });

  it("hides DPIAs from staff and external scoped members", async () => {
    const id = await seedDpia();
    const staff = await createActor("dpia-staff");
    const reviewer = await createActor("dpia-reviewer");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: reviewer.email,
      p_tier: "external_scoped",
    });

    const staffRead = await staff.client.from("dpia").select("id").eq("id", id);
    const reviewerRead = await reviewer.client.from("dpia").select("id").eq("id", id);

    expect(staffRead.data).toEqual([]);
    expect(reviewerRead.data).toEqual([]);
  });

  it("hides DPIAs from another tenant's DPO and anonymous callers", async () => {
    const id = await seedDpia();
    const otherRead = await otherDpo.client.from("dpia").select("id").eq("id", id);
    expect(otherRead.data).toEqual([]);

    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const anonRead = await anon.from("dpia").select("id").eq("id", id);
    expect(anonRead.data ?? []).toEqual([]);
  });

  it("does not let a staff member insert a DPIA", async () => {
    const staff = await createActor("dpia-insert-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const { error } = await staff.client.from("dpia").insert({
      tenant_id: tenantId,
      processing_activity_id: activityId,
      likelihood: "low",
      severity: "low",
      necessity_proportionality: "Staff should not be recording DPO judgment.",
    });

    expect(error).not.toBeNull();
  });
});

describe("approval", () => {
  it("approves, and records who signed it", async () => {
    const id = await seedDpia();

    const { error } = await dpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: id,
    });
    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("dpia")
      .select("status, approved_by, approved_at")
      .eq("id", id)
      .single();

    expect(data!.status).toBe("approved");
    expect(data!.approved_by).toBe(dpo.personId);
    expect(data!.approved_at).not.toBeNull();
  });

  it("refuses approval until residual risk and review date exist", async () => {
    const noResidual = await seedDpia({
      residual_likelihood: null,
      residual_severity: null,
      review_due: "2027-09-12",
    });
    const noReviewDate = await seedDpia({ review_due: null });

    const first = await dpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: noResidual,
    });
    const second = await dpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: noReviewDate,
    });

    expect(first.error?.code).toBe("22023");
    expect(second.error?.code).toBe("22023");
  });

  it("refuses staff and another tenant's DPO as not found", async () => {
    const id = await seedDpia();
    const staff = await createActor("dpia-approve-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const staffAttempt = await staff.client.rpc("approve_dpia", {
      p_caller_person_id: staff.personId,
      p_dpia_id: id,
    });
    const otherAttempt = await otherDpo.client.rpc("approve_dpia", {
      p_caller_person_id: otherDpo.personId,
      p_dpia_id: id,
    });
    const invented = await otherDpo.client.rpc("approve_dpia", {
      p_caller_person_id: otherDpo.personId,
      p_dpia_id: "00000000-0000-4000-8000-000000000000",
    });

    expect(staffAttempt.error?.code).toBe("P0002");
    expect(otherAttempt.error?.code).toBe("P0002");
    expect(invented.error?.code).toBe(otherAttempt.error?.code);
  });

  it("refuses a caller_person_id belonging to somebody else", async () => {
    const id = await seedDpia();
    const { error } = await otherDpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: id,
    });

    expect(error?.code).toBe("42501");
  });

  it("is idempotent and keeps the original approver", async () => {
    const id = await seedDpia();
    await dpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: id,
    });

    const second = await dpo.client.rpc("approve_dpia", {
      p_caller_person_id: dpo.personId,
      p_dpia_id: id,
    });

    expect(second.error).toBeNull();
    const { data } = await adminClient().from("dpia").select("approved_by").eq("id", id).single();
    expect(data!.approved_by).toBe(dpo.personId);
  });

  it("refuses while the workspace is read-only", async () => {
    const owner = await createActor("dpia-readonly");
    const lapsed = await createTenant(owner, "Lapsed DPIA Co", "contractual");
    const activity = await seedActivity(lapsed, { special: ["health_data"] });
    const id = await seedDpia({ tenant_id: lapsed, processing_activity_id: activity });
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", lapsed);

    const { error } = await owner.client.rpc("approve_dpia", {
      p_caller_person_id: owner.personId,
      p_dpia_id: id,
    });

    expect(error?.code).toBe("42501");
  });
});
