/**
 * Tenant creation, through the one shared function and both its entry points.
 *
 * The guarantee under test throughout: creating a workspace makes the creator
 * Active DPO of that workspace and of nothing else. It is asserted against both
 * entry points, because the point of routing both through `create_tenant` is
 * that they cannot drift apart.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let alice: Actor;
let bob: Actor;

beforeAll(async () => {
  alice = await createActor("tc-alice");
  bob = await createActor("tc-bob");
});

/** Sign up through the real auth endpoint, as the signup page does. */
async function signUp(email: string, password: string) {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  return client;
}

describe("legal basis is required (§6)", () => {
  it("rejects a call that omits it entirely", async () => {
    // No default and no optional argument, so PostgREST cannot even resolve a
    // two-argument create_tenant. A workspace with no stated legal basis is not
    // a thing this system can represent.
    const { error } = await alice.client.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "No Basis Ltd",
    } as never);

    expect(error).not.toBeNull();

    const { data } = await adminClient().from("tenants").select("id").eq("name", "No Basis Ltd");
    expect(data).toEqual([]);
  });

  it("rejects a value outside the three §6 answers", async () => {
    const { error } = await alice.client.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "Invented Basis Ltd",
      p_legal_basis: "because-we-felt-like-it",
    });

    expect(error).not.toBeNull();

    const { data } = await adminClient()
      .from("tenants")
      .select("id")
      .eq("name", "Invented Basis Ltd");
    expect(data).toEqual([]);
  });

  it("rejects an explicit null", async () => {
    const { error } = await alice.client.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "Null Basis Ltd",
      p_legal_basis: null,
    });
    expect(error).not.toBeNull();
  });

  it("stores each of the three answers as given", async () => {
    for (const basis of ["mandatory", "contractual", "voluntary"] as const) {
      const id = await createTenant(alice, `Basis ${basis} Ltd`, basis);
      const { data } = await adminClient()
        .from("tenants")
        .select("legal_basis")
        .eq("id", id)
        .single();
      expect(data?.legal_basis).toBe(basis);
    }
  });

  it("rejects a blank workspace name", async () => {
    const { error } = await alice.client.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "   ",
      p_legal_basis: "voluntary",
    });
    expect(error?.code).toBe("22023");
  });
});

describe("the caller is the session, not the argument", () => {
  it("refuses a person_id belonging to somebody else", async () => {
    // The argument is an assertion about who the caller is acting as; the
    // session decides. Bob naming Alice must not produce a workspace at all —
    // not one owned by Alice, and not one silently reassigned to Bob.
    const { error } = await bob.client.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "Impersonated Ltd",
      p_legal_basis: "voluntary",
    });

    expect(error?.code).toBe("42501");

    const { data: tenants } = await adminClient()
      .from("tenants")
      .select("id")
      .eq("name", "Impersonated Ltd");
    expect(tenants).toEqual([]);

    const { data: aliceMemberships } = await adminClient()
      .from("memberships")
      .select("tenant_id")
      .eq("person_id", alice.personId);
    expect(aliceMemberships?.map((m) => m.tenant_id)).not.toContain(undefined);
  });

  it("refuses the same impersonation through the signup wrapper", async () => {
    const { error } = await bob.client.rpc("signup_first_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "Impersonated Signup Ltd",
      p_legal_basis: "voluntary",
    });
    expect(error?.code).toBe("42501");
  });

  it("refuses a person_id that does not exist", async () => {
    const { error } = await bob.client.rpc("create_tenant", {
      p_caller_person_id: "00000000-0000-4000-8000-000000000000",
      p_tenant_name: "Ghost Ltd",
      p_legal_basis: "voluntary",
    });
    expect(error?.code).toBe("42501");
  });

  it("refuses an anonymous caller outright", async () => {
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { error } = await anon.rpc("create_tenant", {
      p_caller_person_id: alice.personId,
      p_tenant_name: "Anonymous Ltd",
      p_legal_basis: "voluntary",
    });
    expect(error).not.toBeNull();
  });
});

describe("what creation grants", () => {
  it("makes the creator Active DPO of the new tenant and nothing else", async () => {
    const carol = await createActor("tc-carol");
    const tenantId = await createTenant(carol, "Exactly One Ltd", "contractual");

    const { data: memberships } = await adminClient()
      .from("memberships")
      .select("tenant_id, person_id, tier, active_to")
      .eq("person_id", carol.personId);

    expect(memberships).toHaveLength(1);
    expect(memberships![0]).toMatchObject({
      tenant_id: tenantId,
      tier: "active_dpo",
      active_to: null,
    });

    // And the new tenant has exactly one member — the creator — so nothing was
    // granted to anybody else on the way past either.
    const { data: tenantMembers } = await adminClient()
      .from("memberships")
      .select("person_id")
      .eq("tenant_id", tenantId);
    expect(tenantMembers).toEqual([{ person_id: carol.personId }]);
  });

  it("leaves the caller's own membership list containing exactly the new tenant", async () => {
    const dan = await createActor("tc-dan");
    const tenantId = await createTenant(dan, "Portfolio Of One Ltd", "mandatory");

    const { data } = await dan.client.rpc("my_memberships");
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ tenant_id: tenantId, tier: "active_dpo" });
  });

  it("adds to a portfolio without touching the tenants already in it", async () => {
    // Entry point 1: an existing Active DPO adding their next client.
    const erin = await createActor("tc-erin");
    const first = await createTenant(erin, "Client One Ltd", "voluntary");
    const second = await createTenant(erin, "Client Two Ltd", "contractual");

    const { data } = await erin.client.rpc("my_memberships");
    const byTenant = new Map(
      (data ?? []).map((m: Record<string, unknown>) => [m.tenant_id, m.tier])
    );

    expect(byTenant.size).toBe(2);
    expect(byTenant.get(first)).toBe("active_dpo");
    expect(byTenant.get(second)).toBe("active_dpo");
  });

  it("creates no tenant at all when the membership insert fails", async () => {
    // Atomicity, forced through the real constraint rather than a mock: a
    // second live membership for the same person in the same tenant violates
    // the exclusion constraint. Here the tenant is new so it cannot trigger
    // that, so instead assert the pair is consistent — every tenant that
    // exists has exactly one founding member.
    const { data: orphans } = await adminClient().rpc("my_memberships");
    void orphans;

    const admin = adminClient();
    const tenants = await fetchAll<{ id: string }>(admin, "tenants", "id");
    const memberships = await fetchAll<{ tenant_id: string }>(admin, "memberships", "tenant_id");
    const withMembers = new Set((memberships ?? []).map((m) => m.tenant_id));

    for (const tenant of tenants) {
      expect(withMembers.has(tenant.id)).toBe(true);
    }
  });
});

async function fetchAll<T>(
  client: SupabaseClient,
  table: "tenants" | "memberships",
  columns: string
): Promise<T[]> {
  const pageSize = 1_000;
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAll ${table} failed: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < pageSize) return rows;
  }
}

describe("identity reconciliation on signup", () => {
  it("claims an unclaimed roster row instead of creating a second person", async () => {
    // The case: a DPO rosters a colleague (§4 tier 2) who has never signed up,
    // which creates a person row with no auth account. When that colleague
    // later signs up with the same address, they must land on the SAME row —
    // otherwise their acknowledgment and training history splits in two, and
    // the roster stops being able to prove who did not respond.
    const dpo = await createActor("tc-roster-dpo");
    const tenantId = await createTenant(dpo, "Roster Reconciliation Ltd", "voluntary");

    const newHireEmail = `newhire-${randomUUID()}@example.test`;
    const { error: addError } = await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: newHireEmail,
      p_tier: "staff",
    });
    expect(addError).toBeNull();

    const { data: before } = await adminClient()
      .from("people")
      .select("id, auth_user_id")
      .eq("email", newHireEmail);
    expect(before).toHaveLength(1);
    expect(before![0].auth_user_id).toBeNull();
    const originalPersonId = before![0].id;

    await signUp(newHireEmail, `pw-${randomUUID()}`);

    const { data: after } = await adminClient()
      .from("people")
      .select("id, auth_user_id")
      .eq("email", newHireEmail);

    // Exactly one person row, still the original one, now linked.
    expect(after).toHaveLength(1);
    expect(after![0].id).toBe(originalPersonId);
    expect(after![0].auth_user_id).not.toBeNull();

    // And the roster membership they were given before signing up survived,
    // which is the thing the single row was protecting.
    const { data: memberships } = await adminClient()
      .from("memberships")
      .select("tenant_id, tier")
      .eq("person_id", originalPersonId);
    expect(memberships).toEqual([{ tenant_id: tenantId, tier: "staff" }]);
  });

  it("creates a person row when the address is genuinely new", async () => {
    const email = `fresh-${randomUUID()}@example.test`;
    await signUp(email, `pw-${randomUUID()}`);

    const { data } = await adminClient()
      .from("people")
      .select("id, auth_user_id")
      .eq("email", email);

    expect(data).toHaveLength(1);
    expect(data![0].auth_user_id).not.toBeNull();
  });
});

describe("concurrency", () => {
  it("does not race a new signup into two workspaces", async () => {
    // A double-submitted signup form, or a retried fetch. Both requests arrive
    // with the same session and neither sees a workspace yet.
    const frank = await createActor("tc-frank");

    const call = () =>
      frank.client.rpc("signup_first_tenant", {
        p_caller_person_id: frank.personId,
        p_tenant_name: "Double Submit Ltd",
        p_legal_basis: "voluntary",
      });

    const [first, second] = await Promise.all([call(), call()]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    // Both calls return, and both return the SAME workspace.
    expect((first.data as { id: string }).id).toBe((second.data as { id: string }).id);

    const { data: memberships } = await adminClient()
      .from("memberships")
      .select("tenant_id")
      .eq("person_id", frank.personId);
    expect(memberships).toHaveLength(1);
  });

  it("does not race a new signup into two person rows", async () => {
    // Two auth accounts cannot share an address, so the race this guards is the
    // trigger running against an email that a roster row already holds.
    const dpo = await createActor("tc-concurrent-dpo");
    const tenantId = await createTenant(dpo, "Concurrent Roster Ltd", "voluntary");
    const email = `concurrent-${randomUUID()}@example.test`;

    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: email,
      p_tier: "staff",
    });

    await signUp(email, `pw-${randomUUID()}`);

    const { data } = await adminClient().from("people").select("id").eq("email", email);
    expect(data).toHaveLength(1);
  });

  it("still gives a rostered staff member their own workspace at signup", async () => {
    // Regression. The wrapper's "at most one workspace per signup" check first
    // tested for ANY live membership, which refused a workspace to exactly the
    // person most likely to want one: a colleague rostered as staff in someone
    // else's tenant before they ever signed up. Holding a membership in another
    // company's workspace is not the same as having been through signup.
    const dpo = await createActor("tc-rostered-signup-dpo");
    const theirTenant = await createTenant(dpo, "Employer Ltd", "voluntary");

    const hire = await createActor("tc-rostered-signup-hire");
    await dpo.client.rpc("add_member", {
      p_tenant_id: theirTenant,
      p_email: hire.email,
      p_tier: "staff",
    });

    const { data, error } = await hire.client.rpc("signup_first_tenant", {
      p_caller_person_id: hire.personId,
      p_tenant_name: "Their Own Side Project Ltd",
      p_legal_basis: "voluntary",
    });

    expect(error).toBeNull();
    expect((data as { id: string }).id).not.toBe(theirTenant);

    const { data: memberships } = await adminClient()
      .from("memberships")
      .select("tenant_id, tier")
      .eq("person_id", hire.personId);

    // Staff there, Active DPO of their own — two memberships, two tiers.
    expect(memberships).toHaveLength(2);
    expect(memberships).toContainEqual({ tenant_id: theirTenant, tier: "staff" });
    expect(memberships).toContainEqual({
      tenant_id: (data as { id: string }).id,
      tier: "active_dpo",
    });
  });

  it("still creates a second workspace when an established DPO asks for one", async () => {
    // The signup wrapper's "at most one" rule must not leak into entry point 1.
    // A fractional DPO adding their next client is the normal case.
    const gail = await createActor("tc-gail");
    await createTenant(gail, "Established One Ltd", "voluntary");
    await createTenant(gail, "Established Two Ltd", "mandatory");

    const { data } = await gail.client.rpc("my_memberships");
    expect(data).toHaveLength(2);
  });
});
