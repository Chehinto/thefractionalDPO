/**
 * Tier-2 assignments (design resume §4).
 *
 * The rule under test is the one sentence §4 gives tier 2: a staff member sees
 * "whatever's been specifically published or assigned to them... Never sees the
 * register, DPIA, or other members' assignments." Most of what follows is that
 * second half.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let alice: Actor;
let bob: Actor;
let tenantId: string;
let otherTenantId: string;

async function assign(
  caller: Actor,
  tenant: string,
  assignee: Actor,
  overrides: Record<string, unknown> = {}
) {
  return caller.client.rpc("assign_to_member", {
    p_caller_person_id: caller.personId,
    p_tenant_id: tenant,
    p_assignee_person_id: assignee.personId,
    p_kind: "scoped_question",
    p_title: "Retention on candidate CVs",
    p_body: "How long do we keep CVs after a role is filled?",
    p_why_asked: "The register has no evidenced retention period for recruitment.",
    p_due_at: null,
    ...overrides,
  });
}

beforeAll(async () => {
  dpo = await createActor("assign-dpo");
  otherDpo = await createActor("assign-other-dpo");
  alice = await createActor("assign-alice");
  bob = await createActor("assign-bob");
  tenantId = await createTenant(dpo, "Assignment Co", "contractual");
  otherTenantId = await createTenant(otherDpo, "Other Assignment Co", "voluntary");

  for (const staff of [alice, bob]) {
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
  }
});

describe("who may assign", () => {
  it("lets the Active DPO push one thing to one live member", async () => {
    const { data, error } = await assign(dpo, tenantId, alice);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      assignee_id: alice.personId,
      kind: "scoped_question",
      status: "pending",
      response: null,
    });
  });

  it("refuses a staff member trying to assign, as not found", async () => {
    const { error } = await assign(alice, tenantId, bob);
    expect(error?.message).toContain("not found");
  });

  it("refuses another tenant's DPO, as not found", async () => {
    const { error } = await assign(otherDpo, tenantId, alice);
    expect(error?.message).toContain("not found");
  });

  // Without the liveness check a DPO could push a question to any person id in
  // the database, including someone on another company's roster entirely.
  it("refuses an assignee who is not a live member here", async () => {
    const outsider = await createActor("assign-outsider");
    const { error } = await assign(dpo, tenantId, outsider);
    expect(error?.message).toContain("not found");
  });

  it("refuses a member whose access has since been revoked", async () => {
    const leaver = await createActor("assign-leaver");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: leaver.email,
      p_tier: "staff",
    });
    // Revoked the way the product revokes. Backdating `active_to` directly is
    // refused by the membership guard — a membership cannot be ended in the
    // past, because that would falsify the provenance range.
    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("person_id", leaver.personId)
      .is("active_to", null)
      .single();
    const { error: revokeError } = await dpo.client.rpc("revoke_membership", {
      p_membership_id: membership!.id,
    });
    expect(revokeError).toBeNull();

    const { error } = await assign(dpo, tenantId, leaver);
    expect(error?.message).toContain("not found");
  });
});

describe("what an assignee can see", () => {
  it("sees their own assignment and not another member's", async () => {
    await assign(dpo, tenantId, alice, { p_title: "For Alice only" });
    await assign(dpo, tenantId, bob, { p_title: "For Bob only" });

    const { data: aliceSees } = await alice.client.from("assignment").select("title");
    const titles = (aliceSees ?? []).map((row) => row.title as string);

    expect(titles).toContain("For Alice only");
    expect(titles).not.toContain("For Bob only");
  });

  it("shows the DPO every assignment in the workspace they run", async () => {
    const { data } = await dpo.client
      .from("assignment")
      .select("title")
      .eq("tenant_id", tenantId);
    const titles = (data ?? []).map((row) => row.title as string);

    expect(titles).toContain("For Alice only");
    expect(titles).toContain("For Bob only");
  });

  it("shows another tenant's DPO nothing of this workspace", async () => {
    const { data } = await otherDpo.client
      .from("assignment")
      .select("id")
      .eq("tenant_id", tenantId);
    expect(data).toEqual([]);
  });

  // §4: being asked one scoped question must not open the register.
  it("does not let being assigned something open the register or a DPIA", async () => {
    const { data: register } = await alice.client
      .from("processing_activity")
      .select("id")
      .eq("tenant_id", tenantId);
    const { data: dpias } = await alice.client.from("dpia").select("id").eq("tenant_id", tenantId);

    expect(register).toEqual([]);
    expect(dpias).toEqual([]);
  });
});

describe("responding", () => {
  it("lets the assignee answer, and records when", async () => {
    const { data: created } = await assign(dpo, tenantId, alice, { p_title: "Answerable" });
    const id = (created as { id: string }).id;

    const { data, error } = await alice.client.rpc("respond_to_assignment", {
      p_caller_person_id: alice.personId,
      p_assignment_id: id,
      p_response: "Twelve months, per the recruitment policy",
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "responded",
      response: "Twelve months, per the recruitment policy",
    });
    expect((data as { responded_at: string }).responded_at).not.toBeNull();
  });

  it("refuses anyone who is not the assignee, including the DPO who asked", async () => {
    const { data: created } = await assign(dpo, tenantId, alice, { p_title: "Alice's alone" });
    const id = (created as { id: string }).id;

    for (const impostor of [bob, dpo]) {
      const { error } = await impostor.client.rpc("respond_to_assignment", {
        p_caller_person_id: impostor.personId,
        p_assignment_id: id,
        p_response: "Not mine to answer",
      });
      expect(error?.message).toContain("not found");
    }
  });

  it("lets an answer be corrected rather than pinning the first one", async () => {
    const { data: created } = await assign(dpo, tenantId, alice, { p_title: "Correctable" });
    const id = (created as { id: string }).id;

    await alice.client.rpc("respond_to_assignment", {
      p_caller_person_id: alice.personId,
      p_assignment_id: id,
      p_response: "30 days",
    });
    await alice.client.rpc("respond_to_assignment", {
      p_caller_person_id: alice.personId,
      p_assignment_id: id,
      p_response: "Checked the contract — 12 months",
    });

    const { data } = await adminClient()
      .from("assignment")
      .select("response, status")
      .eq("id", id)
      .single();
    expect(data).toEqual({ response: "Checked the contract — 12 months", status: "responded" });
  });

  it("refuses an empty response", async () => {
    const { data: created } = await assign(dpo, tenantId, alice, { p_title: "Needs words" });
    const { error } = await alice.client.rpc("respond_to_assignment", {
      p_caller_person_id: alice.personId,
      p_assignment_id: (created as { id: string }).id,
      p_response: "   ",
    });
    expect(error).not.toBeNull();
  });
});

describe("write paths that must not exist", () => {
  it("does not let a staff member insert or update an assignment directly", async () => {
    const { error: insertError } = await alice.client.from("assignment").insert({
      tenant_id: tenantId,
      assignee_id: alice.personId,
      kind: "scoped_question",
      title: "Self-assigned",
      body: "Should be refused",
      created_by: alice.personId,
    });
    expect(insertError).not.toBeNull();

    const { data: created } = await assign(dpo, tenantId, alice, { p_title: "No direct update" });
    const { error: updateError } = await alice.client
      .from("assignment")
      .update({ status: "responded" })
      .eq("id", (created as { id: string }).id);
    expect(updateError).not.toBeNull();
  });
});
