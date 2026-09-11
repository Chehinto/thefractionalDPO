/**
 * Tenant-isolation regression check.
 *
 * A real browser session, signed in as a member of one workspace, trying to
 * reach another by manipulating URLs and calling the API directly. Everything
 * asserted here is behaviour and state — HTTP status, response body, rendered
 * content — never source text.
 *
 * This is the test that has to keep passing forever. The product's entire value
 * rests on one client's compliance record being unreachable from another's, and
 * an access-control regression is the one class of bug that does real harm
 * before anyone notices it.
 */

import { expect, test, type Page } from "@playwright/test";
import { adminClient, createActor, createTenant } from "../support/tenancy-fixtures";

const NONEXISTENT_TENANT = "00000000-0000-4000-8000-000000000000";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(email);
}

test("a member of Tenant A cannot reach Tenant B", async ({ page }) => {
  const alice = await createActor("e2e-alice");
  const bob = await createActor("e2e-bob");
  const acme = await createTenant(alice, "Acme E2E Ltd");
  const bytecorp = await createTenant(bob, "Bytecorp E2E GmbH");

  await signIn(page, alice.email, alice.password);

  // page.request shares the browser context's cookies, so these calls carry
  // Alice's genuine session rather than a synthesised one.
  const own = await page.request.get(`/api/tenants/${acme}`);
  expect(own.status()).toBe(200);
  expect((await own.json()).tenant.name).toBe("Acme E2E Ltd");

  const foreign = await page.request.get(`/api/tenants/${bytecorp}`);
  expect(foreign.status()).toBe(404);
  // Not merely refused — nothing about Bytecorp appears in the refusal.
  expect(await foreign.text()).not.toContain("Bytecorp");

  // And a tenant that does not exist is refused the same way, byte for byte.
  // If these two differed, the difference would confirm which ids are real.
  const missing = await page.request.get(`/api/tenants/${NONEXISTENT_TENANT}`);
  expect(missing.status()).toBe(foreign.status());
  expect(await missing.json()).toEqual(await foreign.json());
});

test("a member of Tenant A cannot read or write Tenant B's roster", async ({ page }) => {
  const alice = await createActor("e2e-roster-alice");
  const bob = await createActor("e2e-roster-bob");
  await createTenant(alice, "Roster A Ltd");
  const bytecorp = await createTenant(bob, "Roster B Ltd");

  await signIn(page, alice.email, alice.password);

  const read = await page.request.get(`/api/tenants/${bytecorp}/members`);
  expect(read.status()).toBe(404);
  expect(await read.text()).not.toContain(bob.email);

  const write = await page.request.post(`/api/tenants/${bytecorp}/members`, {
    data: { email: "intruder@example.test", tier: "active_dpo" },
  });
  expect(write.status()).toBe(404);

  // The write must not have happened, whatever the status said.
  const { data: rows } = await adminClient()
    .from("memberships")
    .select("id")
    .eq("tenant_id", bytecorp);
  expect(rows).toHaveLength(1);
});

test("the portfolio lists only tenants the session actually holds", async ({ page }) => {
  const alice = await createActor("e2e-portfolio-alice");
  const bob = await createActor("e2e-portfolio-bob");
  const first = await createTenant(alice, "Portfolio One Ltd");
  const second = await createTenant(alice, "Portfolio Two Ltd");
  await createTenant(bob, "Not Alice's Ltd");

  await signIn(page, alice.email, alice.password);

  // Two at once: the case a single org column could not represent.
  await expect(page.getByTestId("workspace-count")).toContainText("2 workspaces");

  const me = await page.request.get("/api/me");
  const body = await me.json();
  expect(body.memberships.map((m: { tenantId: string }) => m.tenantId).sort()).toEqual(
    [first, second].sort()
  );
});

test("revocation refuses the very next request in a live session", async ({ page }) => {
  const dpo = await createActor("e2e-dpo");
  const staff = await createActor("e2e-staff");
  const tenant = await createTenant(dpo, "Revocation E2E Ltd");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenant,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff.email, staff.password);

  const before = await page.request.get(`/api/tenants/${tenant}`);
  expect(before.status()).toBe(200);

  // Revoked out of band by the DPO. The browser is not touched: same cookies,
  // same unexpired access token, no sign-out, no refresh.
  const { data: membership } = await adminClient()
    .from("memberships")
    .select("id")
    .eq("tenant_id", tenant)
    .eq("person_id", staff.personId)
    .is("active_to", null)
    .single();

  const { error } = await dpo.client.rpc("revoke_membership", {
    p_membership_id: membership!.id,
  });
  expect(error).toBeNull();

  // The very next request. §4 allows no grace period, so this must already be
  // refused — not after the token expires, not after a reload.
  const after = await page.request.get(`/api/tenants/${tenant}`);
  expect(after.status()).toBe(404);

  await page.reload();
  await expect(page.getByTestId("workspace-count")).toContainText("0 workspaces");
});

test("an anonymous visitor reaches nothing", async ({ page }) => {
  const alice = await createActor("e2e-anon-alice");
  const tenant = await createTenant(alice, "Anon Probe Ltd");

  const tenantResponse = await page.request.get(`/api/tenants/${tenant}`);
  expect(tenantResponse.status()).toBe(401);

  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(401);

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});
