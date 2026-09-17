/**
 * The session → membership resolver, in isolation.
 *
 * The database suite proves RLS refuses foreign tenants. This proves the
 * application layer refuses them too, and refuses them the same way — the two
 * are independent, and a leak needs both to fail.
 *
 * Supabase is mocked here on purpose: what is under test is the decision logic,
 * not the query. The real query is covered by tenancy-rls.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestClient: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ requestClient: mocks.requestClient }));

import {
  requireMembership,
  requireSession,
  TenantAccessError,
  type Membership,
} from "@/lib/tenant-access";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function membershipRow(tenantId: string, tier: string) {
  return {
    membership_id: "33333333-3333-4333-8333-333333333333",
    tenant_id: tenantId,
    tenant_name: "Acme Ltd",
    tenant_status: "active",
    tier,
    active_from: "2026-01-01T00:00:00Z",
    active_to: null,
  };
}

/** Minimal stand-in for the supabase client surface the resolver touches. */
function stubClient(options: {
  user?: { id: string } | null;
  person?: { id: string; email: string } | null;
  memberships?: Record<string, unknown>[];
}) {
  const { user = { id: "auth-1" }, person = { id: "person-1", email: "a@example.test" } } =
    options;

  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: person, error: null }) }),
      }),
    }),
    rpc: async () => ({ data: options.memberships ?? [], error: null }),
  };
}

function withClient(options: Parameters<typeof stubClient>[0]) {
  mocks.requestClient.mockResolvedValue(stubClient(options));
}

async function expectTenantError(promise: Promise<unknown>, status: 401 | 404) {
  await expect(promise).rejects.toBeInstanceOf(TenantAccessError);
  await promise.catch((e: TenantAccessError) => expect(e.status).toBe(status));
}

describe("requireSession", () => {
  it("refuses an anonymous caller with 401", async () => {
    withClient({ user: null });
    await expectTenantError(requireSession(), 401);
  });

  it("refuses a session with no person row with 401, not an empty portfolio", async () => {
    // An empty portfolio and a broken sign-up trigger look identical on screen
    // but need opposite fixes, so they must not collapse into one response.
    withClient({ person: null });
    await expectTenantError(requireSession(), 401);
  });

  it("returns only live memberships, as given by the database", async () => {
    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });
    const session = await requireSession();

    expect(session.memberships).toHaveLength(1);
    expect(session.memberships[0]).toMatchObject<Partial<Membership>>({
      tenantId: TENANT_A,
      tier: "active_dpo",
      tenantStatus: "active",
    });
  });
});

describe("requireMembership", () => {
  it("allows a tenant the session actually holds", async () => {
    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });
    const { membership } = await requireMembership(TENANT_A);
    expect(membership.tenantId).toBe(TENANT_A);
  });

  it("refuses a tenant the session does not hold with 404", async () => {
    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });
    await expectTenantError(requireMembership(TENANT_B), 404);
  });

  it("refuses a tenant that does not exist identically", async () => {
    // The two refusals must be indistinguishable, or the difference between
    // them enumerates which workspaces are real.
    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });

    const foreign = await requireMembership(TENANT_B).catch((e: TenantAccessError) => e);
    const missing = await requireMembership(
      "99999999-9999-4999-8999-999999999999"
    ).catch((e: TenantAccessError) => e);

    expect((foreign as TenantAccessError).status).toBe((missing as TenantAccessError).status);
    expect((foreign as TenantAccessError).message).toBe((missing as TenantAccessError).message);
  });

  it("refuses the wrong tier with 404 rather than 403", async () => {
    // A 403 would confirm the resource exists and merely needs a higher tier.
    // §4 tier 2 says staff never see the register at all — including whether
    // there is one.
    withClient({ memberships: [membershipRow(TENANT_A, "staff")] });
    await expectTenantError(requireMembership(TENANT_A, { tier: "active_dpo" }), 404);
  });

  it("admits active_dpo and staff when no tier is asked for", async () => {
    // The un-tiered call means "may use the workspace UI", and both tier 1 and
    // tier 2 may — tier 2 with less on the page, which is RLS's job, not this
    // function's.
    for (const tier of ["active_dpo", "staff"] as const) {
      withClient({ memberships: [membershipRow(TENANT_A, tier)] });
      const { membership } = await requireMembership(TENANT_A);
      expect(membership.tier).toBe(tier);
    }
  });

  it("refuses external_scoped with 404 even though it is a real membership", async () => {
    // §4 tier 3 is token-scoped disclosure served by `scoped_register()`. A
    // tier-3 member inside the workspace UI would see nothing (RLS refuses the
    // rows) but would still learn the workspace exists, so the application
    // layer refuses them the page as well.
    withClient({ memberships: [membershipRow(TENANT_A, "external_scoped")] });
    await expectTenantError(requireMembership(TENANT_A), 404);
  });

  it("refuses external_scoped indistinguishably from a non-member", async () => {
    withClient({ memberships: [membershipRow(TENANT_A, "external_scoped")] });
    const scoped = await requireMembership(TENANT_A).catch((e: TenantAccessError) => e);

    withClient({ memberships: [] });
    const stranger = await requireMembership(TENANT_A).catch((e: TenantAccessError) => e);

    expect((scoped as TenantAccessError).status).toBe(404);
    expect((scoped as TenantAccessError).status).toBe((stranger as TenantAccessError).status);
    expect((scoped as TenantAccessError).message).toBe((stranger as TenantAccessError).message);
  });

  it("admits external_scoped only when a caller opts in explicitly", async () => {
    // The escape hatch exists so that widening is always a visible decision at
    // the call site rather than a default.
    withClient({ memberships: [membershipRow(TENANT_A, "external_scoped")] });
    const { membership } = await requireMembership(TENANT_A, {
      tiers: ["active_dpo", "staff", "external_scoped"],
    });
    expect(membership.tier).toBe("external_scoped");
  });

  it("does not let tier and tiers be combined", () => {
    // Mutually exclusive by type rather than by runtime precedence: a
    // combination like this one reads as narrowing but would admit MORE than
    // the list beside it, so it is made unrepresentable instead of resolved.
    // Enforced by `npx tsc --noEmit` — the assertion below is only here so the
    // line is executed and cannot be dropped as dead code.
    const both: Parameters<typeof requireMembership>[1] = {
      tier: "external_scoped",
      // @ts-expect-error - tiers cannot be passed alongside tier
      tiers: ["active_dpo"],
    };
    expect(both).toBeDefined();
  });

  it("keeps an explicit tier exact, refusing a tier the default would admit", async () => {
    // Guards the allow-list against loosening `{ tier }`: staff is inside
    // WORKSPACE_UI_TIERS, and must still be refused when active_dpo was asked
    // for by name.
    withClient({ memberships: [membershipRow(TENANT_A, "staff")] });
    await expectTenantError(requireMembership(TENANT_A, { tier: "active_dpo" }), 404);

    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });
    await expectTenantError(requireMembership(TENANT_A, { tier: "staff" }), 404);
  });

  it("refuses a malformed tenant id without consulting the database", async () => {
    withClient({ memberships: [membershipRow(TENANT_A, "active_dpo")] });
    await expectTenantError(requireMembership("not-a-uuid"), 404);
    await expectTenantError(requireMembership(""), 404);
    await expectTenantError(requireMembership(null), 404);
  });

  it("does not let a client-supplied id widen access", async () => {
    // The id is only ever matched against the server-resolved list. Holding no
    // memberships means no tenant id can be made to resolve, whatever is sent.
    withClient({ memberships: [] });
    await expectTenantError(requireMembership(TENANT_A), 404);
    await expectTenantError(requireMembership(TENANT_B), 404);
  });
});
