import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let staff: Actor;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  dpo = await createActor("software-discovery-dpo");
  otherDpo = await createActor("software-discovery-other");
  staff = await createActor("software-discovery-staff");
  tenantId = await createTenant(dpo, "Software Discovery Co", "contractual");
  otherTenantId = await createTenant(otherDpo, "Other Software Discovery Co", "mandatory");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

async function seedSignal(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("software_discovery_signal")
    .insert({
      tenant_id: tenantId,
      source: "accounting_subscription",
      source_name: "Xero",
      external_ref: "txn-123",
      software_name: "Notion",
      vendor_name: "Notion Labs",
      signal_text: "NOTION.SO monthly workspace subscription",
      amount: 24.5,
      currency: "GBP",
      occurred_on: "2026-09-12",
      ...overrides,
    })
    .select("id")
    .single();

  if (error) throw new Error(`seedSignal failed: ${error.message}`);
  return data!.id as string;
}

describe("software discovery signals", () => {
  it("shows signals only to Active DPOs", async () => {
    const id = await seedSignal();

    const ownerRead = await dpo.client
      .from("software_discovery_signal")
      .select("id")
      .eq("id", id);
    const staffRead = await staff.client
      .from("software_discovery_signal")
      .select("id")
      .eq("id", id);
    const otherRead = await otherDpo.client
      .from("software_discovery_signal")
      .select("id")
      .eq("id", id);

    expect(ownerRead.data).toEqual([{ id }]);
    expect(staffRead.data).toEqual([]);
    expect(otherRead.data).toEqual([]);
  });

  it("does not let staff or other tenants insert discovery signals", async () => {
    const staffInsert = await staff.client.from("software_discovery_signal").insert({
      tenant_id: tenantId,
      source: "sso_application",
      source_name: "Okta",
      software_name: "Greenhouse",
      signal_text: "Greenhouse Recruiting",
    });
    expect(staffInsert.error).not.toBeNull();

    const otherInsert = await dpo.client.from("software_discovery_signal").insert({
      tenant_id: otherTenantId,
      source: "accounting_payment",
      source_name: "Xero",
      software_name: "Slack",
      signal_text: "SLACK monthly subscription",
    });
    expect(otherInsert.error).not.toBeNull();
  });

  it("lets the DPO create a signal and link an AI suggestion to it", async () => {
    const { data: signal, error: signalError } = await dpo.client
      .from("software_discovery_signal")
      .insert({
        tenant_id: tenantId,
        source: "sso_application",
        source_name: "Okta",
        software_name: "Greenhouse",
        signal_text: "Greenhouse Recruiting",
      })
      .select("id")
      .single();
    expect(signalError).toBeNull();

    const { data: suggestion, error: suggestionError } = await dpo.client
      .from("ai_suggestion")
      .insert({
        tenant_id: tenantId,
        kind: "register_intake",
        title: "Greenhouse software discovery review",
        response_text: "Review whether Greenhouse processes applicant data.",
        source_excerpt: "Greenhouse Recruiting",
        source_label: "Okta sso application signal",
        confidence: "inferred",
        confidence_score: 75,
        software_discovery_signal_id: signal!.id,
      })
      .select("id")
      .single();

    expect(suggestionError).toBeNull();

    const read = await dpo.client
      .from("ai_suggestion")
      .select("id, software_discovery_signal_id")
      .eq("id", suggestion!.id);
    expect(read.data).toEqual([
      {
        id: suggestion!.id,
        software_discovery_signal_id: signal!.id,
      },
    ]);
  });
});
