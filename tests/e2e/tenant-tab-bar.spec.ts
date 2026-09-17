/**
 * The persistent tenant tab bar (fixes: "the menu at the top is not behaving
 * like tabs, the menu disappears" — there was no layout under this segment at
 * all, so every page hand-rolled its own single back-link).
 *
 * Everything here is a real browser session, because the point being checked
 * is what actually renders and what a direct request actually gets back —
 * never source-text matching, per CLAUDE.md's testing rules.
 */

import { expect, test, type Page } from "@playwright/test";
import { createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

test.describe("staff tab bar", () => {
  test("shows exactly the four staff tabs, by role and accessible name", async ({ page }) => {
    const dpo = await createActor("tabs-staff-dpo");
    const staff = await createActor("tabs-staff-member");
    const tenantId = await createTenant(dpo, "Tab Bar Staff Ltd", "contractual");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);
    await page.goto(`/tenants/${tenantId}/my-tasks`);

    const tabs = page.getByRole("navigation", { name: "Workspace" }).getByRole("link");
    await expect(tabs).toHaveCount(4);
    await expect(tabs).toHaveText(["Home", "Register", "My training", "Raise a request"]);
  });

  test("never renders a DPO-only link on any page a staff member can reach", async ({ page }) => {
    const dpo = await createActor("tabs-staff-leak-dpo");
    const staff = await createActor("tabs-staff-leak-member");
    const tenantId = await createTenant(dpo, "No Leak Ltd", "voluntary");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    // These four routes are the ones staff can actually reach. If a DPO-only
    // href shows up on any of them, that is a leaked link a staff member could
    // click through to, even though the tab bar was never supposed to offer
    // it.
    const dpoOnlyHrefs = [
      `/tenants/${tenantId}/incidents`,
      `/tenants/${tenantId}/roster`,
      `/tenants/${tenantId}/settings`,
      `/tenants/${tenantId}/training-admin`,
      `/tenants/${tenantId}/intake`,
    ];

    for (const path of ["/my-tasks", "/register", "/training", "/request-vendor"]) {
      await page.goto(`/tenants/${tenantId}${path}`);
      const hrefs = await page.locator("a[href]").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href"))
      );
      for (const dpoOnlyHref of dpoOnlyHrefs) {
        expect(hrefs).not.toContain(dpoOnlyHref);
      }
    }
  });

  test("still refuses direct navigation to a DPO-only route with 404", async ({ page }) => {
    const dpo = await createActor("tabs-staff-direct-dpo");
    const staff = await createActor("tabs-staff-direct-member");
    const tenantId = await createTenant(dpo, "Direct Nav Ltd", "mandatory");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    // Typing the URL directly rather than following a link the tab bar never
    // offered: the tab bar is only a hint, the page's own `requireMembership`
    // is the actual gate. Incidents holds the Art. 33 breach register and the
    // 72-hour notification clock — nothing a staff member has a lawful reason
    // to see, and this must refuse it exactly as if the route did not exist.
    const response = await page.request.get(`/tenants/${tenantId}/incidents`);
    expect(response.status()).toBe(404);
  });
});

test.describe("active_dpo tab bar", () => {
  test("shows exactly the seven DPO tabs, by role and accessible name", async ({ page }) => {
    const dpo = await createActor("tabs-dpo");
    const tenantId = await createTenant(dpo, "Tab Bar DPO Ltd", "contractual");

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);

    const tabs = page.getByRole("navigation", { name: "Workspace" }).getByRole("link");
    await expect(tabs).toHaveCount(7);
    await expect(tabs).toHaveText([
      "Overview",
      "Register",
      "Intake",
      "Incidents",
      "Training",
      "People",
      "Settings",
    ]);
  });

  test("keeps the tab bar on screen while moving between pages", async ({ page }) => {
    // The regression this whole task fixes: before this layout existed, moving
    // off the workspace root left the user with, at best, a single back-link.
    const dpo = await createActor("tabs-persist-dpo");
    const tenantId = await createTenant(dpo, "Persistent Nav Ltd", "voluntary");

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);
    // Scoped to the nav: the overview also renders its own "Register"
    // shortcut, so an unscoped locator matches two links and Playwright
    // strict mode fails before asserting anything.
    await page
      .getByRole("navigation", { name: "Workspace" })
      .getByRole("link", { name: "Register", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}/register$`));

    const tabs = page.getByRole("navigation", { name: "Workspace" }).getByRole("link");
    await expect(tabs).toHaveCount(7);
    await expect(page.getByRole("link", { name: "Incidents" })).toBeVisible();
  });
});
