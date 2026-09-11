/**
 * What the portfolio is allowed to contain.
 *
 * §4 defines the portfolio as a rollup across every tenant where the person
 * currently appears on the Active DPO list — which means two things must both
 * hold, and they fail differently:
 *
 *   a tenant they are active_dpo on IS in the portfolio;
 *   a tenant they can reach by any OTHER route is NOT.
 *
 * The second is the one that matters. A staff membership in someone else's
 * company must never put that company on this person's portfolio, because the
 * portfolio is the list of workspaces they are the professional of record for,
 * and appearing there is a claim about liability, not about access.
 *
 * Asserted at the query layer here; the rendered page is covered in
 * tests/e2e/portfolio.spec.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let otherDpo: Actor;
let ownTenant: string;
let foreignTenant: string;

/** The portfolio, as the page derives it: active_dpo memberships only. */
async function portfolioOf(actor: Actor): Promise<string[]> {
  const { data } = await actor.client.rpc("my_memberships");
  return (data ?? [])
    .filter((m: Record<string, unknown>) => m.tier === "active_dpo")
    .map((m: Record<string, unknown>) => m.tenant_id as string);
}

beforeAll(async () => {
  dpo = await createActor("pf-dpo");
  otherDpo = await createActor("pf-other");
  ownTenant = await createTenant(dpo, "Own Workspace Ltd", "contractual");
  foreignTenant = await createTenant(otherDpo, "Someone Elses Ltd", "mandatory");
});

describe("a DPO only ever sees tenants they are active_dpo on", () => {
  it("includes their own workspace", async () => {
    expect(await portfolioOf(dpo)).toEqual([ownTenant]);
  });

  it("excludes a workspace they are merely staff in", async () => {
    // The important case. Being rostered somewhere gives access to assigned
    // items; it does not make you that company's DPO, and the portfolio must
    // not imply otherwise.
    const employer = await createActor("pf-employer");
    const employerTenant = await createTenant(employer, "Employer Ltd", "voluntary");
    await employer.client.rpc("add_member", {
      p_tenant_id: employerTenant,
      p_email: dpo.email,
      p_tier: "staff",
    });

    const portfolio = await portfolioOf(dpo);
    expect(portfolio).not.toContain(employerTenant);
    expect(portfolio).toEqual([ownTenant]);

    // They can still reach it — they are a member — which is exactly why
    // filtering on tier rather than on reachability is the whole point.
    const { data: reachable } = await dpo.client.from("tenants").select("id").eq("id", employerTenant);
    expect(reachable).toEqual([{ id: employerTenant }]);
  });

  it("excludes a workspace they hold external scoped access to", async () => {
    const auditee = await createActor("pf-auditee");
    const auditeeTenant = await createTenant(auditee, "Audited Ltd", "contractual");
    await auditee.client.rpc("add_member", {
      p_tenant_id: auditeeTenant,
      p_email: dpo.email,
      p_tier: "external_scoped",
    });

    expect(await portfolioOf(dpo)).not.toContain(auditeeTenant);
  });

  it("excludes another DPO's workspace entirely", async () => {
    expect(await portfolioOf(dpo)).not.toContain(foreignTenant);

    // And the rows the dashboard reads for each workspace are refused too, so a
    // tenant id that leaked into the query would still return nothing.
    const { data: tenants } = await dpo.client.from("tenants").select("id").eq("id", foreignTenant);
    const { data: members } = await dpo.client
      .from("memberships")
      .select("id")
      .eq("tenant_id", foreignTenant);

    expect(tenants).toEqual([]);
    expect(members).toEqual([]);
  });

  it("drops a workspace the moment the active_dpo membership is revoked", async () => {
    const leaver = await createActor("pf-leaver");
    const tenantId = await createTenant(leaver, "Handed Over Ltd", "voluntary");
    expect(await portfolioOf(leaver)).toEqual([tenantId]);

    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("person_id", leaver.personId)
      .single();
    await leaver.client.rpc("revoke_membership", { p_membership_id: membership!.id });

    // Same session, same token. §4's revocation has no grace period, and the
    // portfolio is a live rollup rather than anything cached.
    expect(await portfolioOf(leaver)).toEqual([]);
  });

  it("shows a person with no active_dpo membership an empty portfolio", async () => {
    const staffOnly = await createActor("pf-staff-only");
    const employer = await createActor("pf-staff-employer");
    const employerTenant = await createTenant(employer, "Only Employer Ltd", "voluntary");
    await employer.client.rpc("add_member", {
      p_tenant_id: employerTenant,
      p_email: staffOnly.email,
      p_tier: "staff",
    });

    expect(await portfolioOf(staffOnly)).toEqual([]);
  });
});

describe("the data the dashboard reads per workspace", () => {
  it("is scoped to the Active DPO list even when asked for more", async () => {
    // The page passes its own tenant id list to `.in()`. If that list were ever
    // widened by a bug, RLS still has to be the thing that refuses — so ask for
    // both ids explicitly and confirm only one comes back.
    const { data } = await dpo.client
      .from("tenants")
      .select("id")
      .in("id", [ownTenant, foreignTenant]);

    expect(data).toEqual([{ id: ownTenant }]);
  });

  it("exposes no tier-2 scoped content, because none exists to expose", async () => {
    // The employee preview renders nothing because there is nothing to render:
    // no publishing or assignment table exists yet. Asserted against what the
    // API actually exposes — the real attack surface — so that the day such a
    // table is added, this fails and forces the preview to be re-examined
    // rather than silently starting to have something to leak.
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const spec = (await response.json()) as { definitions?: Record<string, unknown> };
    const exposed = Object.keys(spec.definitions ?? {}).sort();

    expect(exposed).toEqual(["memberships", "people", "tenants"]);
  });
});

describe("tenant lifecycle state the dashboard reads", () => {
  it("stamps status_changed_at so the §5 purge clock has a start", async () => {
    const owner = await createActor("pf-lapsed");
    const tenantId = await createTenant(owner, "Lapsed Ltd", "contractual");

    const { data: before } = await adminClient()
      .from("tenants")
      .select("status, status_changed_at")
      .eq("id", tenantId)
      .single();

    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

    const { data: after } = await adminClient()
      .from("tenants")
      .select("status, status_changed_at")
      .eq("id", tenantId)
      .single();

    expect(after!.status).toBe("read_only");
    expect(new Date(after!.status_changed_at).getTime()).toBeGreaterThan(
      new Date(before!.status_changed_at).getTime()
    );
  });

  it("does not let an Active DPO rewrite their own billing state", async () => {
    // Regression. A whole-table UPDATE grant let a DPO set their own workspace
    // to read_only — and then not set it back, because a non-active tenant
    // refuses writes. One request, workspace bricked, service role to recover.
    const owner = await createActor("pf-status");
    const tenantId = await createTenant(owner, "Status Guard Ltd", "voluntary");

    const { error } = await owner.client
      .from("tenants")
      .update({ status: "read_only" })
      .eq("id", tenantId);
    expect(error).not.toBeNull();

    const { data } = await adminClient()
      .from("tenants")
      .select("status")
      .eq("id", tenantId)
      .single();
    expect(data!.status).toBe("active");
  });

  it("still lets them maintain the facts that are theirs", async () => {
    // §6's answer legitimately changes — a contract ends, an obligation begins.
    const owner = await createActor("pf-basis");
    const tenantId = await createTenant(owner, "Basis Change Ltd", "voluntary");

    const { error } = await owner.client
      .from("tenants")
      .update({ name: "Basis Change Group", legal_basis: "mandatory" })
      .eq("id", tenantId);
    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("tenants")
      .select("name, legal_basis")
      .eq("id", tenantId)
      .single();
    expect(data).toEqual({ name: "Basis Change Group", legal_basis: "mandatory" });
  });
});
