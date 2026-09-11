/**
 * The tenancy layer, asserted against a real Postgres with RLS on.
 *
 * Every read and write here goes through a signed-in client, never the service
 * role, because the policies are the thing being tested. A test that used the
 * service role would pass with the policies deleted.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  createActor,
  createTenant,
  type Actor,
} from "../support/tenancy-fixtures";

let alice: Actor; // Active DPO of Acme
let bob: Actor; // Active DPO of Bytecorp, no relationship to Acme
let acme: string;
let bytecorp: string;

beforeAll(async () => {
  alice = await createActor("alice");
  bob = await createActor("bob");
  acme = await createTenant(alice, "Acme Ltd");
  bytecorp = await createTenant(bob, "Bytecorp GmbH");
});

describe("identity", () => {
  it("creates a person row when an auth user signs up", async () => {
    const { data } = await adminClient()
      .from("people")
      .select("id, email")
      .eq("auth_user_id", alice.authUserId)
      .single();

    expect(data?.id).toBe(alice.personId);
    expect(data?.email).toBe(alice.email);
  });
});

describe("tenant creation", () => {
  it("lists the creator as the founding Active DPO", async () => {
    const { data } = await alice.client.rpc("my_memberships");
    const acmeRow = (data ?? []).find(
      (m: Record<string, unknown>) => m.tenant_id === acme
    );

    expect(acmeRow?.tier).toBe("active_dpo");
    expect(acmeRow?.tenant_name).toBe("Acme Ltd");
  });

  it("refuses a direct insert into tenants", async () => {
    // Default deny: `tenants` has no INSERT policy, so the only way a workspace
    // comes into existence is create_tenant(), which takes the founding member
    // from the session rather than from the request.
    const { error } = await alice.client.from("tenants").insert({ name: "Smuggled Ltd" });
    expect(error).not.toBeNull();
  });

  it("refuses a direct insert into people", async () => {
    const { error } = await alice.client
      .from("people")
      .insert({ email: "stranger@example.test" });
    expect(error).not.toBeNull();
  });
});

describe("the portfolio a single org column cannot represent", () => {
  it("lets one person hold live memberships in several tenants at once", async () => {
    // This is the case AxioVendo's users.org_id could not express, and the
    // reason memberships is a table. A fractional DPO advising three companies
    // is the normal case, not an edge case.
    const carol = await createActor("carol");
    const first = await createTenant(carol, "First Client Ltd");
    const second = await createTenant(carol, "Second Client Ltd");
    const third = await createTenant(carol, "Third Client Ltd");

    const { data } = await carol.client.rpc("my_memberships");
    const tenantIds = (data ?? []).map((m: Record<string, unknown>) => m.tenant_id);

    expect(tenantIds).toEqual(expect.arrayContaining([first, second, third]));
    expect(tenantIds).toHaveLength(3);
  });
});

describe("tenant isolation", () => {
  it("hides another tenant's row entirely", async () => {
    const { data } = await bob.client.from("tenants").select("id").eq("id", acme);
    expect(data).toEqual([]);
  });

  it("hides another tenant's memberships", async () => {
    const { data } = await bob.client.from("memberships").select("id").eq("tenant_id", acme);
    expect(data).toEqual([]);
  });

  it("returns not-found rather than forbidden when revoking a foreign membership", async () => {
    // Bob knows a real membership id belonging to Acme. The error must be
    // indistinguishable from one for an id that does not exist, or the response
    // becomes an oracle for probing other companies' workspaces.
    const { data: acmeMemberships } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme);
    const realId = acmeMemberships![0].id as string;
    const inventedId = "00000000-0000-4000-8000-000000000000";

    const real = await bob.client.rpc("revoke_membership", { p_membership_id: realId });
    const invented = await bob.client.rpc("revoke_membership", { p_membership_id: inventedId });

    expect(real.error?.code).toBe("P0002");
    expect(invented.error?.code).toBe("P0002");
    expect(real.error?.code).toBe(invented.error?.code);
  });

  it("answers the access predicates false, never null, for a non-member", async () => {
    // Regression. These returned NULL for a non-member, which RLS treats as
    // "no row" (safe) but a PL/pgSQL `if not has_tier(...) then raise` does NOT
    // treat as a failure — the guard is skipped and the caller proceeds as
    // authorised. Bob was able to revoke Alice's membership in Acme through
    // exactly that hole. A definite false is what closes it.
    const { data } = await bob.client.rpc("my_memberships");
    expect(data).not.toContainEqual(expect.objectContaining({ tenant_id: acme }));

    const { data: probe } = await adminClient().rpc("add_member", {
      p_tenant_id: acme,
      p_email: "probe@example.test",
      p_tier: "staff",
    });
    // The service role has no person row at all, so every predicate must
    // resolve to false rather than null for it too.
    expect(probe).toBeNull();
  });

  it("refuses to add a member to a tenant the caller does not administer", async () => {
    const { error } = await bob.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: "intruder@example.test",
      p_tier: "staff",
    });
    expect(error?.code).toBe("P0002");
  });
});

describe("membership tiers", () => {
  it("does not let a staff member enumerate the roster", async () => {
    // §4 tier 2: staff never see other members. The check is that they get an
    // empty result, not an error — an error would still confirm a roster is
    // there to be refused.
    const dan = await createActor("dan");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: dan.email,
      p_tier: "staff",
    });

    const { data: rows } = await dan.client.from("memberships").select("id").eq("tenant_id", acme);

    // Dan sees exactly his own membership and nobody else's.
    expect(rows).toHaveLength(1);

    const { data: mine } = await dan.client.rpc("my_memberships");
    expect(mine?.[0]?.tier).toBe("staff");
  });

  it("does not let a staff member add other members", async () => {
    const erin = await createActor("erin");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: erin.email,
      p_tier: "staff",
    });

    const { error } = await erin.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: "someone-else@example.test",
      p_tier: "staff",
    });
    expect(error?.code).toBe("P0002");
  });

  it("rejects a second live membership for the same person in one tenant", async () => {
    const frank = await createActor("frank");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: frank.email,
      p_tier: "staff",
    });

    const { error } = await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: frank.email,
      p_tier: "active_dpo",
    });

    // 23P01 is the exclusion constraint. Two live tiers would make "what can
    // this person see" ambiguous, which is not a question RLS should have to
    // guess at.
    expect(error?.code).toBe("23P01");
  });
});

describe("revocation is immediate and binary (§4)", () => {
  it("refuses the very next request on the same session", async () => {
    const gail = await createActor("gail");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: gail.email,
      p_tier: "staff",
    });

    // Before: Gail's session can reach Acme.
    const before = await gail.client.from("tenants").select("id").eq("id", acme);
    expect(before.data).toEqual([{ id: acme }]);

    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .eq("person_id", gail.personId)
      .is("active_to", null)
      .single();

    await alice.client.rpc("revoke_membership", { p_membership_id: membership!.id });

    // After, on the SAME client — meaning the same access token, not re-issued
    // and not refreshed. This is the assertion that matters: if membership were
    // carried in the JWT, this request would still succeed for up to an hour,
    // which is exactly the grace period §4 rules out.
    const after = await gail.client.from("tenants").select("id").eq("id", acme);
    expect(after.data).toEqual([]);

    const { data: portfolio } = await gail.client.rpc("my_memberships");
    expect(portfolio).toEqual([]);
  });

  it("keeps the revoked row as the provenance record (§5)", async () => {
    const hank = await createActor("hank");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: hank.email,
      p_tier: "active_dpo",
    });

    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .eq("person_id", hank.personId)
      .is("active_to", null)
      .single();

    await alice.client.rpc("revoke_membership", { p_membership_id: membership!.id });

    // The row survives with a closed window: that date range is the DPO's
    // "companies advised" credential and the tenant's audit trail. Access ends;
    // the record does not.
    const { data: after } = await adminClient()
      .from("memberships")
      .select("id, active_from, active_to, revoked_by")
      .eq("id", membership!.id)
      .single();

    expect(after?.active_to).not.toBeNull();
    expect(after?.revoked_by).toBe(alice.personId);
  });

  it("refuses to delete a membership outright", async () => {
    const { data: rows } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .limit(1);

    const { error, data } = await alice.client
      .from("memberships")
      .delete()
      .eq("id", rows![0].id)
      .select();

    // No DELETE policy exists, so the row is simply not visible to delete.
    // Either an error or an empty result is a refusal; what must not happen is
    // the row disappearing.
    expect(error ?? data).toBeTruthy();
    const { data: still } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("id", rows![0].id);
    expect(still).toHaveLength(1);
  });

  it("is idempotent", async () => {
    const ivan = await createActor("ivan");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: ivan.email,
      p_tier: "staff",
    });
    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .eq("person_id", ivan.personId)
      .is("active_to", null)
      .single();

    const first = await alice.client.rpc("revoke_membership", {
      p_membership_id: membership!.id,
    });
    const second = await alice.client.rpc("revoke_membership", {
      p_membership_id: membership!.id,
    });

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
  });

  it("lets a revoked person be granted a fresh membership later", async () => {
    const jane = await createActor("jane");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: jane.email,
      p_tier: "staff",
    });
    const { data: first } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .eq("person_id", jane.personId)
      .is("active_to", null)
      .single();
    await alice.client.rpc("revoke_membership", { p_membership_id: first!.id });

    // Coming back is a new row with its own start date, so the gap in access
    // stays visible in the record rather than being edited away.
    const { error } = await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: jane.email,
      p_tier: "active_dpo",
    });
    expect(error).toBeNull();

    const { data: history } = await adminClient()
      .from("memberships")
      .select("id, tier, active_to")
      .eq("tenant_id", acme)
      .eq("person_id", jane.personId);
    expect(history).toHaveLength(2);
  });

  it("allows the last Active DPO to stand down, leaving the seat empty (§5)", async () => {
    // The product must force an explicit choice when a tenant is left with no
    // Active DPO. That is a product decision, so this layer must not quietly
    // prevent the situation by refusing the revocation.
    const kim = await createActor("kim");
    const soleClient = await createTenant(kim, "Sole Client Ltd");
    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", soleClient)
      .single();

    const { error } = await kim.client.rpc("revoke_membership", {
      p_membership_id: membership!.id,
    });
    expect(error).toBeNull();

    const { data: after } = await kim.client.from("tenants").select("id").eq("id", soleClient);
    expect(after).toEqual([]);
  });
});

describe("provenance integrity", () => {
  let target: string;

  beforeAll(async () => {
    const liam = await createActor("liam");
    await alice.client.rpc("add_member", {
      p_tenant_id: acme,
      p_email: liam.email,
      p_tier: "staff",
    });
    const { data } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", acme)
      .eq("person_id", liam.personId)
      .single();
    target = data!.id as string;
  });

  it("freezes the tier", async () => {
    const { error } = await alice.client
      .from("memberships")
      .update({ tier: "active_dpo" })
      .eq("id", target);
    expect(error?.code).toBe("42501");
  });

  it("freezes the start date", async () => {
    const { error } = await alice.client
      .from("memberships")
      .update({ active_from: "2020-01-01T00:00:00Z" })
      .eq("id", target);
    expect(error?.code).toBe("42501");
  });

  it("refuses to backdate the end of a membership", async () => {
    // Backdating would claim the DPO stopped advising before they actually
    // did — a falsified provenance range, and a defence the tenant cannot rely
    // on. Future dates remain legal: that is a scheduled expiry (§4 tier 3).
    const { error } = await alice.client
      .from("memberships")
      .update({ active_to: "2020-01-01T00:00:00Z" })
      .eq("id", target);
    expect(error?.code).toBe("42501");
  });
});

describe("read-only tenants (§5 non-payment)", () => {
  it("blocks writes but keeps reads working", async () => {
    const mia = await createActor("mia");
    const lapsed = await createTenant(mia, "Lapsed Card Ltd");
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", lapsed);

    // A lapsed card must never destroy a compliance register, and the DPO has
    // to be able to read what they are being asked to pay for.
    const { data: readable } = await mia.client.from("tenants").select("id").eq("id", lapsed);
    expect(readable).toEqual([{ id: lapsed }]);

    const { error } = await mia.client.rpc("add_member", {
      p_tenant_id: lapsed,
      p_email: "newhire@example.test",
      p_tier: "staff",
    });
    expect(error?.code).toBe("42501");
  });
});

describe("anonymous callers", () => {
  it("see nothing at all", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const tenants = await anon.from("tenants").select("id");
    const memberships = await anon.from("memberships").select("id");
    const people = await anon.from("people").select("id");

    expect(tenants.data ?? []).toEqual([]);
    expect(memberships.data ?? []).toEqual([]);
    expect(people.data ?? []).toEqual([]);
  });
});
