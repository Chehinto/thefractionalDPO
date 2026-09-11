/**
 * The portfolio dashboard as a DPO actually reads it.
 *
 * Ordering, dependency flags and confidence tags are asserted here rather than
 * by importing the queue functions, because Next only permits its own exports
 * from a page file — and because the property that matters is what appears on
 * the screen, in what order, not what a pure function returned.
 *
 * The toggle tests are the security ones. "Employee view" is a preview; the
 * risk is that it becomes, or is mistaken for, an access switch.
 */

import { expect, test, type Page } from "@playwright/test";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

/** Give a tenant an external grant that expires in `days`. */
async function grantExternalAccess(owner: Actor, tenantId: string, email: string, days: number) {
  await owner.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: email,
    p_tier: "external_scoped",
  });
  const { data: membership } = await adminClient()
    .from("memberships")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("tier", "external_scoped")
    .is("active_to", null)
    .limit(1)
    .single();
  await adminClient()
    .from("memberships")
    .update({ active_to: new Date(Date.now() + days * 86_400_000).toISOString() })
    .eq("id", membership!.id);
}

test("lists only the workspaces the caller is Active DPO of", async ({ page }) => {
  const dpo = await createActor("e2e-pf-dpo");
  const mine = await createTenant(dpo, "Northwind Retail", "contractual");

  // A workspace where they are only staff must not appear on the portfolio.
  const employer = await createActor("e2e-pf-employer");
  const employerTenant = await createTenant(employer, "Someone Elses Company", "mandatory");
  await employer.client.rpc("add_member", {
    p_tenant_id: employerTenant,
    p_email: dpo.email,
    p_tier: "staff",
  });

  await signIn(page, dpo);

  await expect(page.getByTestId("workspace-card")).toHaveCount(1);
  await expect(page.getByTestId("workspace-name")).toHaveText("Northwind Retail");
  await expect(page.locator(`[data-tenant-id="${mine}"]`)).toBeVisible();

  // Not merely absent from the list — absent from the response entirely.
  expect(await page.content()).not.toContain("Someone Elses Company");
  expect(await page.content()).not.toContain(employerTenant);
});

test("orders the queue by what runs out first, not by area", async ({ page }) => {
  const dpo = await createActor("e2e-pf-order");
  const tenantId = await createTenant(dpo, "Ordering Ltd", "mandatory");

  // Two dated items, deliberately created so that the one expiring sooner is
  // in a different area from the one expiring later — if the list grouped by
  // area, the order would come out differently.
  await grantExternalAccess(dpo, tenantId, `auditor-soon-${Date.now()}@example.test`, 3);
  await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

  await signIn(page, dpo);

  // Assert the ordering property, not the arithmetic. Exact day counts depend
  // on how long the fixture took to run, and a test that pins them fails for
  // reasons that have nothing to do with ordering.
  const clocks = await page.getByTestId("queue-clock").allTextContents();

  // Soonest first: the external grant (days) before the purge (a year), and the
  // sole-DPO item, which has no clock at all, last.
  expect(clocks[0]).toMatch(/^Expires in \d+d$/);
  expect(clocks[1]).toMatch(/^Purged in \d+d$/);
  expect(clocks[clocks.length - 1]).toBe("No successor");

  // Every dated clock is in non-decreasing order.
  const dated = clocks
    .map((c) => c.match(/(\d+)d/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => Number(m[1]));
  expect([...dated].sort((a, b) => a - b)).toEqual(dated);

  // And the areas confirm it is not grouped by area: Audit sits above
  // Governance here purely because it runs out sooner.
  const rows = page.getByTestId("queue-row");
  await expect(rows.first()).toContainText("Audit");
  await expect(rows.nth(1)).toContainText("Governance");
});

test("flags a blocking dependency between rows", async ({ page }) => {
  const dpo = await createActor("e2e-pf-block");
  const tenantId = await createTenant(dpo, "Blocked Ltd", "voluntary");

  // A rostered colleague who has never signed in, in a workspace that has gone
  // read-only. Chasing them is wasted effort until billing is fixed, because
  // `app.tenant_is_writable` refuses roster writes on a read-only tenant.
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: `never-signed-in-${Date.now()}@example.test`,
    p_tier: "staff",
  });
  await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

  await signIn(page, dpo);

  await expect(page.getByTestId("blocked-by")).toContainText("Workspace is read-only");
  await expect(page.getByTestId("dependency-note")).toContainText("cannot move until");
});

test("shows confidence tags rather than hiding what it does not know", async ({ page }) => {
  const dpo = await createActor("e2e-pf-tags");
  await createTenant(dpo, "Tagged Ltd", "contractual");

  await signIn(page, dpo);

  // stated: a person answered it at signup. inferred: derived from memberships,
  // not a stated headcount. unknown: never asked, and shown as such.
  await expect(page.getByTestId("confidence-stated").first()).toHaveText("stated");
  await expect(page.getByTestId("confidence-inferred").first()).toHaveText("inferred");
  await expect(page.getByTestId("confidence-unknown").first()).toHaveText("unknown");

  await expect(page.getByText("Not recorded").first()).toBeVisible();
});

test("a person with no Active DPO membership gets an empty portfolio", async ({ page }) => {
  const staff = await createActor("e2e-pf-staff");
  const employer = await createActor("e2e-pf-staff-employer");
  const tenantId = await createTenant(employer, "Employs Them Ltd", "voluntary");
  await employer.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff);

  await expect(page.getByTestId("portfolio-empty")).toBeVisible();
  await expect(page.getByTestId("workspace-card")).toHaveCount(0);
  expect(await page.content()).not.toContain("Employs Them Ltd");
});

test.describe("the view toggle is a preview, not an access switch", () => {
  test("employee view reveals no workspace data, and fetches nothing to do it", async ({ page }) => {
    const dpo = await createActor("e2e-toggle-dpo");
    await createTenant(dpo, "Confidential Client Ltd", "mandatory");
    await signIn(page, dpo);

    // Everything is on screen in DPO view.
    await expect(page.getByTestId("workspace-card")).toHaveCount(1);

    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.getByTestId("view-employee").click();
    await expect(page.getByTestId("employee-preview")).toBeVisible();

    // Nothing about the workspace survives into the preview — not the name, not
    // a queue row, not a member.
    await expect(page.getByTestId("workspace-card")).toHaveCount(0);
    await expect(page.getByTestId("queue-row")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain("Confidential Client Ltd");
    expect(html).not.toContain("Workspace is read-only");

    // And it did not go and fetch tier-2 data to render the preview: the only
    // traffic is the page navigation and its own assets.
    const dataCalls = requests.filter((url) => /\/rest\/v1\/|\/api\//.test(url));
    expect(dataCalls).toEqual([]);
  });

  test("employee view cannot be widened by URL parameters", async ({ page }) => {
    const dpo = await createActor("e2e-toggle-params");
    const tenantId = await createTenant(dpo, "Not Via Params Ltd", "contractual");
    await signIn(page, dpo);

    // Every shape someone would try if they thought the toggle were a switch.
    for (const query of [
      `?view=employee&tenant=${tenantId}`,
      `?view=employee&tier=staff`,
      `?view=employee&scope=all`,
      `?view=EMPLOYEE`,
    ]) {
      await page.goto(`/${query}`);
      const html = await page.content();
      // Either it is the preview (empty), or it is the DPO view the session
      // already had. Never a third thing, and never scoped content.
      expect(html).not.toContain("assigned to them specifically and also");
      if (await page.getByTestId("employee-preview").isVisible()) {
        expect(html).not.toContain("Not Via Params Ltd");
        await expect(page.getByTestId("queue-row")).toHaveCount(0);
      }
    }
  });

  test("does not grant a staff member a DPO view", async ({ page }) => {
    // The toggle renders less, never more. Removing it does not promote anyone.
    const staff = await createActor("e2e-toggle-staff");
    const employer = await createActor("e2e-toggle-employer");
    const tenantId = await createTenant(employer, "Their Employer Ltd", "mandatory");
    await employer.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    for (const query of ["", "?view=dpo", "?view=employee"]) {
      await page.goto(`/${query}`);
      await expect(page.getByTestId("workspace-card")).toHaveCount(0);
      expect(await page.content()).not.toContain("Their Employer Ltd");
    }
  });

  test("an anonymous visitor gets neither view", async ({ page }) => {
    await page.goto("/?view=employee");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByTestId("employee-preview")).toHaveCount(0);
    await expect(page.getByTestId("workspace-card")).toHaveCount(0);
  });
});
