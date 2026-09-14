import { beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let staff: Actor;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  dpo = await createActor("vendor-request-dpo");
  otherDpo = await createActor("vendor-request-other");
  staff = await createActor("vendor-request-staff");
  tenantId = await createTenant(dpo, "Vendor Request Co", "contractual");
  otherTenantId = await createTenant(otherDpo, "Other Vendor Request Co", "mandatory");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

async function seedRequest(
  requester: Actor = staff,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await requester.client
    .from("vendor_request")
    .insert({
      tenant_id: tenantId,
      requester_id: requester.personId,
      vendor_name: "ScreenCo",
      purpose: "Criminal record checks for regulated roles",
      data_description: "Candidate identity and criminal record check result",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedRequest failed: ${error.message}`);
  return data!.id as string;
}

describe("vendor requests", () => {
  it("lets a staff member submit their own request pending DPO review", async () => {
    const id = await seedRequest();

    const { data } = await adminClient()
      .from("vendor_request")
      .select("status, requester_id")
      .eq("id", id)
      .single();

    expect(data).toEqual({
      status: "pending_dpo_review",
      requester_id: staff.personId,
    });
  });

  it("refuses a request created already approved", async () => {
    const { error } = await adminClient().from("vendor_request").insert({
      tenant_id: tenantId,
      requester_id: staff.personId,
      vendor_name: "ApprovedCo",
      purpose: "Trying to skip review",
      status: "approved",
    });

    expect(error?.code).toBe("42501");
  });

  it("does not let a staff member submit as another requester", async () => {
    const { error } = await staff.client.from("vendor_request").insert({
      tenant_id: tenantId,
      requester_id: dpo.personId,
      vendor_name: "PretendCo",
      purpose: "Pretend someone else asked",
    });

    expect(error).not.toBeNull();
  });

  it("shows a request to its requester and the DPO, but not another tenant", async () => {
    const id = await seedRequest();

    const staffRead = await staff.client.from("vendor_request").select("id").eq("id", id);
    const dpoRead = await dpo.client.from("vendor_request").select("id").eq("id", id);
    const otherRead = await otherDpo.client.from("vendor_request").select("id").eq("id", id);

    expect(staffRead.data).toEqual([{ id }]);
    expect(dpoRead.data).toEqual([{ id }]);
    expect(otherRead.data).toEqual([]);
  });

  it("does not let one staff member read another staff member's request", async () => {
    const id = await seedRequest();
    const otherStaff = await createActor("vendor-request-other-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: otherStaff.email,
      p_tier: "staff",
    });

    const read = await otherStaff.client.from("vendor_request").select("id").eq("id", id);
    expect(read.data).toEqual([]);
  });

  it("refuses foreign tenants and anonymous callers", async () => {
    const { error } = await staff.client.from("vendor_request").insert({
      tenant_id: otherTenantId,
      requester_id: staff.personId,
      vendor_name: "ForeignCo",
      purpose: "Trying to write into another tenant",
    });
    expect(error).not.toBeNull();

    const id = await seedRequest();
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const anonRead = await anon.from("vendor_request").select("id").eq("id", id);
    expect(anonRead.data ?? []).toEqual([]);
  });

  it("lets the Active DPO approve the request", async () => {
    const id = await seedRequest();

    const approved = await dpo.client.rpc("approve_vendor_request", {
      p_caller_person_id: dpo.personId,
      p_request_id: id,
    });
    expect(approved.error).toBeNull();

    const { data } = await adminClient()
      .from("vendor_request")
      .select("status, reviewed_by")
      .eq("id", id)
      .single();
    expect(data).toEqual({ status: "approved", reviewed_by: dpo.personId });
  });
});
