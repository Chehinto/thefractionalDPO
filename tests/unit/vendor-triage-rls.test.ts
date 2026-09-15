/**
 * The guarantees the database makes about triage, not the ones the code makes.
 *
 * The important one: a model's recollection can never be recorded as `stated`.
 * That is a check constraint rather than a convention, because the difference
 * between "a tool that helps a DPO decide where to look" and "a tool that
 * launders a model's memory into a compliance record" is exactly this line.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let staff: Actor;
let tenantId: string;

const BASE = {
  software_name: "Notion",
  vendor_name: "Notion Labs",
  homepage_url: "https://notion.so",
  what_it_does: "A workspace tool for notes and databases.",
  confidence: "inferred" as const,
  confidence_score: 70,
};

beforeAll(async () => {
  dpo = await createActor("triage-dpo");
  staff = await createActor("triage-staff");
  tenantId = await createTenant(dpo, "Triage Co", "contractual");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

describe("recollection is not evidence", () => {
  it("refuses a triage recorded as stated", async () => {
    const { error } = await dpo.client
      .from("vendor_triage")
      .insert({ ...BASE, tenant_id: tenantId, confidence: "stated" });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("vendor_triage_is_never_stated");
  });

  it("accepts inferred and unknown", async () => {
    for (const confidence of ["inferred", "unknown"]) {
      const { error } = await dpo.client
        .from("vendor_triage")
        .insert({ ...BASE, tenant_id: tenantId, confidence });
      expect(error).toBeNull();
    }
  });
});

describe("a verdict has to be reasoned", () => {
  it("refuses a verdict with no rationale", async () => {
    const { error } = await dpo.client.from("vendor_triage").insert({
      ...BASE,
      tenant_id: tenantId,
      verdict: "high_risk_mitigation_required",
      confidence_score: 90,
    });
    expect(error?.message).toContain("vendor_triage_verdict_is_reasoned");
  });

  it("accepts a verdict that carries its reasoning and a score", async () => {
    const { error } = await dpo.client.from("vendor_triage").insert({
      ...BASE,
      tenant_id: tenantId,
      verdict: "dpia_recommended",
      verdict_rationale: "Staff routinely paste personal data into shared notes.",
      confidence_score: 70,
    });
    expect(error).toBeNull();
  });
});

describe("who can see and create it", () => {
  it("cannot be created already reviewed", async () => {
    const { error } = await adminClient()
      .from("vendor_triage")
      .insert({ ...BASE, tenant_id: tenantId, status: "approved" });
    expect(error?.code).toBe("42501");
  });

  // A staff member who reported the software does not thereby get a view of
  // the risk assessment of it.
  it("hides triage from staff, and refuses their insert", async () => {
    const { data } = await staff.client.from("vendor_triage").select("id").eq("tenant_id", tenantId);
    expect(data).toEqual([]);

    const { error } = await staff.client
      .from("vendor_triage")
      .insert({ ...BASE, tenant_id: tenantId });
    expect(error).not.toBeNull();
  });

  it("lets the Active DPO mark one reviewed, attributed to them", async () => {
    const { data: created } = await dpo.client
      .from("vendor_triage")
      .insert({ ...BASE, tenant_id: tenantId })
      .select("id")
      .single();

    const { error } = await dpo.client.rpc("review_vendor_triage", {
      p_caller_person_id: dpo.personId,
      p_triage_id: created!.id,
    });
    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("vendor_triage")
      .select("status, reviewed_by")
      .eq("id", created!.id)
      .single();
    expect(data).toEqual({ status: "approved", reviewed_by: dpo.personId });
  });

  it("refuses a staff member marking one reviewed, as not found", async () => {
    const { data: created } = await dpo.client
      .from("vendor_triage")
      .insert({ ...BASE, tenant_id: tenantId })
      .select("id")
      .single();

    const { error } = await staff.client.rpc("review_vendor_triage", {
      p_caller_person_id: staff.personId,
      p_triage_id: created!.id,
    });
    expect(error?.message).toContain("not found");
  });
});
