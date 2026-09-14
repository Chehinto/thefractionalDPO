/**
 * The two outbound settings, and the fact that they are two (design resume §1).
 *
 * §1 settles the consent design and adds one structural constraint: the toggles
 * are "never bundled". These tests pin that as a property of the schema rather
 * than of whatever form happens to render them — independent columns,
 * independent defaults, and an asymmetry that is the whole legal argument.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let staff: Actor;
let tenantId: string;

beforeAll(async () => {
  dpo = await createActor("outbound-dpo");
  staff = await createActor("outbound-staff");
  tenantId = await createTenant(dpo, "Outbound Co", "contractual");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

describe("defaults", () => {
  // The asymmetry is deliberate. Authorizing the platform to act as the DPO
  // cannot be assumed; the recommendation note is the DPO's own client
  // configuring their own outbound message, which §1 reasons is ordinary B2B
  // service configuration.
  it("does not assume authority to send, and does include the note", async () => {
    const { data } = await adminClient()
      .from("tenants")
      .select("platform_send_authorized, vendor_recommendation_note")
      .eq("id", tenantId)
      .single();

    expect(data).toEqual({
      platform_send_authorized: false,
      vendor_recommendation_note: true,
    });
  });
});

describe("they are two settings, not one", () => {
  it("lets each be changed without touching the other", async () => {
    await dpo.client
      .from("tenants")
      .update({ platform_send_authorized: true })
      .eq("id", tenantId);

    const { data: afterFirst } = await adminClient()
      .from("tenants")
      .select("platform_send_authorized, vendor_recommendation_note")
      .eq("id", tenantId)
      .single();
    expect(afterFirst).toEqual({
      platform_send_authorized: true,
      vendor_recommendation_note: true,
    });

    // Turning the note off must not withdraw the authorization, and vice
    // versa. A single bundled column could not express this.
    await dpo.client
      .from("tenants")
      .update({ vendor_recommendation_note: false })
      .eq("id", tenantId);

    const { data: afterSecond } = await adminClient()
      .from("tenants")
      .select("platform_send_authorized, vendor_recommendation_note")
      .eq("id", tenantId)
      .single();
    expect(afterSecond).toEqual({
      platform_send_authorized: true,
      vendor_recommendation_note: false,
    });
  });
});

describe("who may change them", () => {
  it("refuses a staff member", async () => {
    const before = await adminClient()
      .from("tenants")
      .select("vendor_recommendation_note")
      .eq("id", tenantId)
      .single();

    await staff.client
      .from("tenants")
      .update({ vendor_recommendation_note: true })
      .eq("id", tenantId);

    const after = await adminClient()
      .from("tenants")
      .select("vendor_recommendation_note")
      .eq("id", tenantId)
      .single();
    expect(after.data).toEqual(before.data);
  });

  // 0017 restates the column grant list in full, because a column-level grant
  // REPLACES the previous one. This is the check that the restatement did not
  // quietly hand over a column that was deliberately withheld.
  it("still refuses the billing and lifecycle state the grant withholds", async () => {
    await dpo.client.from("tenants").update({ status: "suspended" }).eq("id", tenantId);

    const { data } = await adminClient()
      .from("tenants")
      .select("status")
      .eq("id", tenantId)
      .single();
    expect(data!.status).toBe("active");
  });
});
