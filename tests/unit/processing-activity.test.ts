/**
 * The register table: what it refuses, who can see it, and who can approve.
 *
 * Three properties are load-bearing here, and all three are asserted against a
 * real Postgres rather than a mock, because all three are enforced by the
 * database and would pass trivially against a stub:
 *
 *   an invalid confidence tag or category is refused at write time;
 *   a staff member has no general read access to the register (§4 tier 2);
 *   nothing reaches `approved` except through the approve function (§4).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import { seedActivity, shareActivity } from "../support/register-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  dpo = await createActor("pa-dpo");
  otherDpo = await createActor("pa-other");
  tenantId = await createTenant(dpo, "Register Co", "contractual");
  otherTenantId = await createTenant(otherDpo, "Rival Register Co", "mandatory");
});

describe("the database refuses invalid values, not just the UI", () => {
  it("rejects a confidence tag that is not one of the three", async () => {
    // §9 names exactly three. "probably", "high", "80%" are the shapes a model
    // or a careless import would produce, and a register that accepts them
    // cannot answer "which of these facts is actually evidenced".
    for (const bogus of ["probably", "high", "80%", "STATED", ""]) {
      const { error } = await adminClient()
        .from("processing_activity")
        .insert({
          tenant_id: tenantId,
          purpose: "Bogus confidence",
          purpose_confidence: bogus,
          recipient_vendor_confidence: "stated",
          role: "controller",
          data_categories_confidence: "stated",
          data_subjects_confidence: "stated",
          retention_confidence: "stated",
        });
      expect(error, `confidence "${bogus}" should be refused`).not.toBeNull();
    }
  });

  it("rejects a data category outside the two enums", async () => {
    const { error: ordinaryError } = await adminClient()
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        purpose: "Bad ordinary category",
        purpose_confidence: "stated",
        recipient_vendor_confidence: "stated",
        role: "controller",
        data_categories_ordinary: ["favourite_colour"],
        data_categories_confidence: "stated",
        data_subjects_confidence: "stated",
        retention_confidence: "stated",
      });
    expect(ordinaryError).not.toBeNull();

    // A near-miss on a special category is the dangerous one: a typo that
    // silently lands in no category at all would also silently clear the DPIA
    // flag on data that should have raised it.
    const { error: specialError } = await adminClient()
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        purpose: "Bad special category",
        purpose_confidence: "stated",
        recipient_vendor_confidence: "stated",
        role: "controller",
        data_categories_special: ["helth_data"],
        data_categories_confidence: "stated",
        data_subjects_confidence: "stated",
        retention_confidence: "stated",
      });
    expect(specialError).not.toBeNull();
  });

  it("rejects an unknown data subject and an unknown role", async () => {
    const base = {
      tenant_id: tenantId,
      purpose_confidence: "stated",
      recipient_vendor_confidence: "stated",
      data_categories_confidence: "stated",
      data_subjects_confidence: "stated",
      retention_confidence: "stated",
    };

    const { error: subjectError } = await adminClient()
      .from("processing_activity")
      .insert({ ...base, purpose: "Bad subject", role: "controller", data_subjects: ["shareholders"] });
    expect(subjectError).not.toBeNull();

    const { error: roleError } = await adminClient()
      .from("processing_activity")
      .insert({ ...base, purpose: "Bad role", role: "joint_controller" });
    expect(roleError).not.toBeNull();
  });

  it("rejects an activity with no purpose", async () => {
    const { error } = await adminClient()
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        purpose: "   ",
        purpose_confidence: "stated",
        recipient_vendor_confidence: "stated",
        role: "controller",
        data_categories_confidence: "stated",
        data_subjects_confidence: "stated",
        retention_confidence: "stated",
      });
    expect(error).not.toBeNull();
  });
});

describe("nothing arrives approved (§4)", () => {
  it("defaults a new activity to pending_dpo_review", async () => {
    const id = await seedActivity(tenantId);
    const { data } = await adminClient()
      .from("processing_activity")
      .select("status, approved_at, approved_by")
      .eq("id", id)
      .single();

    expect(data).toMatchObject({ status: "pending_dpo_review", approved_at: null, approved_by: null });
  });

  it("refuses an insert that arrives already approved, even from the service role", async () => {
    // The service role bypasses both RLS and the column grants, so the trigger
    // is what stands between a future import script and a register full of
    // approvals nobody made.
    const { error } = await adminClient()
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        status: "approved",
        purpose: "Smuggled in approved",
        purpose_confidence: "stated",
        recipient_vendor_confidence: "stated",
        role: "controller",
        data_categories_confidence: "stated",
        data_subjects_confidence: "stated",
        retention_confidence: "stated",
      });

    expect(error?.code).toBe("42501");
  });

  it("does not let a DPO write the status column directly", async () => {
    const id = await seedActivity(tenantId);

    const { error } = await dpo.client
      .from("processing_activity")
      .update({ status: "approved" })
      .eq("id", id);
    expect(error).not.toBeNull();

    const { data } = await adminClient()
      .from("processing_activity")
      .select("status")
      .eq("id", id)
      .single();
    expect(data!.status).toBe("pending_dpo_review");
  });

  it("lets a DPO edit the content of a draft", async () => {
    const id = await seedActivity(tenantId);
    const { error } = await dpo.client
      .from("processing_activity")
      .update({ purpose: "Payroll administration and pensions", purpose_confidence: "stated" })
      .eq("id", id);
    expect(error).toBeNull();
  });
});

describe("the DPIA flag is derived, not written", () => {
  it("is false for ordinary categories alone", async () => {
    const id = await seedActivity(tenantId, { ordinary: ["contact_details"], special: [] });
    const { data } = await adminClient()
      .from("processing_activity")
      .select("dpia_risk_flag")
      .eq("id", id)
      .single();
    expect(data!.dpia_risk_flag).toBe(false);
  });

  it("is true as soon as any special category is present", async () => {
    const id = await seedActivity(tenantId, { special: ["health_data"] });
    const { data } = await adminClient()
      .from("processing_activity")
      .select("dpia_risk_flag")
      .eq("id", id)
      .single();
    expect(data!.dpia_risk_flag).toBe(true);
  });

  it("is true for criminal offence data, which is Art. 10 rather than Art. 9", async () => {
    // §9 puts it in the special enum so it carries the same weight. If it had
    // been given a third home, this activity would record criminal-offence data
    // with the flag clear.
    const id = await seedActivity(tenantId, { special: ["criminal_offence_data"] });
    const { data } = await adminClient()
      .from("processing_activity")
      .select("dpia_risk_flag")
      .eq("id", id)
      .single();
    expect(data!.dpia_risk_flag).toBe(true);
  });

  it("cannot be set by hand", async () => {
    const { error } = await adminClient()
      .from("processing_activity")
      .insert({
        tenant_id: tenantId,
        purpose: "Claiming no risk",
        purpose_confidence: "stated",
        recipient_vendor_confidence: "stated",
        role: "controller",
        data_categories_special: ["health_data"],
        data_categories_confidence: "stated",
        data_subjects_confidence: "stated",
        retention_confidence: "stated",
        dpia_risk_flag: false,
      });
    expect(error).not.toBeNull();
  });
});

describe("who can see a draft (§4 tier 2)", () => {
  let draftId: string;

  beforeAll(async () => {
    draftId = await seedActivity(tenantId, { purpose: "Visible only to the DPO" });
  });

  it("shows it to the Active DPO", async () => {
    const { data } = await dpo.client.from("processing_activity").select("id").eq("id", draftId);
    expect(data).toEqual([{ id: draftId }]);
  });

  it("hides the whole register from a staff member of the same tenant", async () => {
    // The most important policy in the file. A staff member is a member of this
    // workspace and can reach it — and still sees nothing in the register.
    const staff = await createActor("pa-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const { data } = await staff.client.from("processing_activity").select("id");
    expect(data).toEqual([]);
  });

  it("shows a staff member exactly the activity shared with them, and nothing else", async () => {
    const staff = await createActor("pa-shared-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    const sharedId = await seedActivity(tenantId, { purpose: "Shared with one person" });
    await shareActivity(sharedId, staff.personId);

    const { data } = await staff.client.from("processing_activity").select("id, purpose");
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(sharedId);

    // Explicitly: the other drafts in the same tenant stay invisible.
    const { data: probe } = await staff.client
      .from("processing_activity")
      .select("id")
      .eq("id", draftId);
    expect(probe).toEqual([]);
  });

  it("hides it from an external_scoped member", async () => {
    const reviewer = await createActor("pa-reviewer");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: reviewer.email,
      p_tier: "external_scoped",
    });

    const { data } = await reviewer.client.from("processing_activity").select("id");
    expect(data).toEqual([]);
  });

  it("hides it from another tenant's Active DPO", async () => {
    const { data } = await otherDpo.client.from("processing_activity").select("id");
    const ids = (data ?? []).map((a: { id: string }) => a.id);
    expect(ids).not.toContain(draftId);
  });

  it("hides it from an anonymous caller", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data } = await anon.from("processing_activity").select("id");
    expect(data ?? []).toEqual([]);
  });

  it("stops showing it the moment the DPO's membership is revoked", async () => {
    const leaver = await createActor("pa-leaver");
    const leaverTenant = await createTenant(leaver, "Leaver Register Co", "voluntary");
    const id = await seedActivity(leaverTenant);

    const before = await leaver.client.from("processing_activity").select("id").eq("id", id);
    expect(before.data).toEqual([{ id }]);

    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", leaverTenant)
      .eq("person_id", leaver.personId)
      .is("active_to", null)
      .single();
    await leaver.client.rpc("revoke_membership", { p_membership_id: membership!.id });

    const after = await leaver.client.from("processing_activity").select("id").eq("id", id);
    expect(after.data).toEqual([]);
  });
});

describe("approval is active_dpo only", () => {
  it("approves, and records who did it", async () => {
    const id = await seedActivity(tenantId);

    const { error } = await dpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: dpo.personId,
      p_activity_id: id,
    });
    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("processing_activity")
      .select("status, approved_by, approved_at")
      .eq("id", id)
      .single();

    expect(data!.status).toBe("approved");
    expect(data!.approved_by).toBe(dpo.personId);
    expect(data!.approved_at).not.toBeNull();
  });

  it("refuses a staff member of the same tenant", async () => {
    const staff = await createActor("pa-approve-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
    const id = await seedActivity(tenantId);
    await shareActivity(id, staff.personId);

    // They can SEE this one — it was shared with them — and still cannot
    // approve it. Visibility and authority are different things.
    const visible = await staff.client.from("processing_activity").select("id").eq("id", id);
    expect(visible.data).toEqual([{ id }]);

    const { error } = await staff.client.rpc("approve_processing_activity", {
      p_caller_person_id: staff.personId,
      p_activity_id: id,
    });
    expect(error?.code).toBe("P0002");
  });

  it("refuses another tenant's DPO, reporting it as missing", async () => {
    const id = await seedActivity(tenantId);
    const { error } = await otherDpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: otherDpo.personId,
      p_activity_id: id,
    });
    expect(error?.code).toBe("P0002");

    const invented = await otherDpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: otherDpo.personId,
      p_activity_id: "00000000-0000-4000-8000-000000000000",
    });
    // Indistinguishable from a real id in someone else's register.
    expect(invented.error?.code).toBe(error?.code);
  });

  it("refuses a caller_person_id belonging to somebody else", async () => {
    const id = await seedActivity(tenantId);
    const { error } = await otherDpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: dpo.personId,
      p_activity_id: id,
    });
    expect(error?.code).toBe("42501");

    const { data } = await adminClient()
      .from("processing_activity")
      .select("status")
      .eq("id", id)
      .single();
    expect(data!.status).toBe("pending_dpo_review");
  });

  it("refuses an anonymous caller", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const id = await seedActivity(tenantId);
    const { error } = await anon.rpc("approve_processing_activity", {
      p_caller_person_id: dpo.personId,
      p_activity_id: id,
    });
    expect(error).not.toBeNull();
  });

  it("is idempotent and keeps the original approver", async () => {
    const id = await seedActivity(tenantId);
    await dpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: dpo.personId,
      p_activity_id: id,
    });

    const second = await dpo.client.rpc("approve_processing_activity", {
      p_caller_person_id: dpo.personId,
      p_activity_id: id,
    });
    expect(second.error).toBeNull();

    const { data } = await adminClient()
      .from("processing_activity")
      .select("approved_by")
      .eq("id", id)
      .single();
    expect(data!.approved_by).toBe(dpo.personId);
  });

  it("refuses while the workspace is read-only (§5)", async () => {
    const owner = await createActor("pa-readonly");
    const lapsed = await createTenant(owner, "Lapsed Register Co", "contractual");
    const id = await seedActivity(lapsed);
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", lapsed);

    const { error } = await owner.client.rpc("approve_processing_activity", {
      p_caller_person_id: owner.personId,
      p_activity_id: id,
    });
    expect(error?.code).toBe("42501");
  });
});
