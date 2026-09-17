/**
 * The register screen.
 *
 * The unit suite proves the policies. This proves the screen honours them —
 * that a staff member who opens the register URL directly sees only what was
 * shared with them, that the approve action is genuinely gated rather than just
 * visually hidden, and that confidence tags are on screen rather than buried.
 */

import { expect, test, type Page } from "@playwright/test";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import { seedActivity, shareActivity } from "../support/register-fixtures";

const NONEXISTENT = "00000000-0000-4000-8000-000000000000";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

test("a DPO sees every draft, with its status and confidence tags on screen", async ({ page }) => {
  const dpo = await createActor("reg-dpo");
  const tenantId = await createTenant(dpo, "Register View Co", "contractual");
  await seedActivity(tenantId, {
    purpose: "Payroll administration",
    purposeConfidence: "stated",
    categoriesConfidence: "inferred",
    retention: null,
    retentionConfidence: "unknown",
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/register`);

  await expect(page.getByTestId("activity")).toHaveCount(1);
  await expect(page.getByTestId("activity-status")).toHaveAttribute("data-status", "pending_dpo_review");
  await expect(page.getByTestId("activity-purpose")).toContainText("Payroll administration");

  // All three tags are visible, not collapsed behind a disclosure.
  await expect(page.getByTestId("confidence-stated").first()).toBeVisible();
  await expect(page.getByTestId("confidence-inferred").first()).toBeVisible();
  await expect(page.getByTestId("confidence-unknown").first()).toBeVisible();

  // An unknown renders as an admission rather than a blank.
  await expect(page.getByText("Not established").first()).toBeVisible();
});

test("reaches the register from the workspace and back", async ({ page }) => {
  const dpo = await createActor("reg-nav");
  const tenantId = await createTenant(dpo, "Navigate Register Co", "voluntary");
  await seedActivity(tenantId);

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}`);
  await page.getByTestId("open-register").click();

  await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}/register$`));
  // The Overview tab, not a per-page back-link: the tab bar replaced those,
  // so this now exercises the navigation the product actually has.
  await page.getByTestId("tab-overview").click();
  await expect(page.getByTestId("tenant-name")).toHaveText("Navigate Register Co");
});

test("shows the special-category flag only where special data is recorded", async ({ page }) => {
  const dpo = await createActor("reg-flag");
  const tenantId = await createTenant(dpo, "Flagged Co", "mandatory");
  await seedActivity(tenantId, { purpose: "Ordinary only", special: [] });
  await seedActivity(tenantId, { purpose: "Occupational health", special: ["health_data"] });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/register`);

  await expect(page.getByTestId("activity")).toHaveCount(2);
  await expect(page.getByTestId("dpia-flag")).toHaveCount(1);
});

test("approving moves a draft to approved", async ({ page }) => {
  const dpo = await createActor("reg-approve");
  const tenantId = await createTenant(dpo, "Approve Co", "contractual");
  const activityId = await seedActivity(tenantId, { purpose: "Customer support records" });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/register`);

  await expect(page.getByTestId("activity-status")).toHaveAttribute("data-status", "pending_dpo_review");
  await page.getByTestId("approve-button").click();

  await expect(page.getByTestId("activity-status")).toHaveAttribute("data-status", "approved");
  // The button is gone because there is nothing left to approve.
  await expect(page.getByTestId("approve-button")).toHaveCount(0);

  const { data } = await adminClient()
    .from("processing_activity")
    .select("status, approved_by")
    .eq("id", activityId)
    .single();
  expect(data!.status).toBe("approved");
  expect(data!.approved_by).toBe(dpo.personId);
});

test.describe("a staff member", () => {
  test("sees nothing when nothing has been shared", async ({ page }) => {
    const dpo = await createActor("reg-staff-dpo");
    const tenantId = await createTenant(dpo, "Closed Register Co", "mandatory");
    await seedActivity(tenantId, { purpose: "Confidential payroll purpose" });

    const staff = await createActor("reg-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);
    await page.goto(`/tenants/${tenantId}/register`);

    await expect(page.getByTestId("activity")).toHaveCount(0);
    await expect(page.getByTestId("register-empty")).toBeVisible();
    // Not merely hidden from the list — absent from the response.
    expect(await page.content()).not.toContain("Confidential payroll purpose");
  });

  test("sees exactly what was shared, and cannot approve it", async ({ page }) => {
    const dpo = await createActor("reg-share-dpo");
    const tenantId = await createTenant(dpo, "Shared Register Co", "contractual");
    const shared = await seedActivity(tenantId, { purpose: "The one they were asked about" });
    await seedActivity(tenantId, { purpose: "None of their business" });

    const staff = await createActor("reg-share-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
    await shareActivity(shared, staff.personId);

    await signIn(page, staff);
    await page.goto(`/tenants/${tenantId}/register`);

    await expect(page.getByTestId("activity")).toHaveCount(1);
    await expect(page.getByTestId("activity-purpose")).toContainText("The one they were asked about");
    expect(await page.content()).not.toContain("None of their business");

    // No approve control — and the absence is not merely cosmetic; the unit
    // suite proves the function refuses them even when called directly.
    await expect(page.getByTestId("approve-button")).toHaveCount(0);
    await expect(page.getByTestId("shared-only-note")).toBeVisible();
  });

  test("cannot open the workspace overview, which stays DPO-only", async ({ page }) => {
    const dpo = await createActor("reg-overview-dpo");
    const tenantId = await createTenant(dpo, "Overview Closed Co", "voluntary");
    const staff = await createActor("reg-overview-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);
    // A staff member holds a live membership, so (task N1) this route
    // redirects them to their own /my-tasks landing page rather than
    // refusing them outright — the DPO overview itself must still never
    // render, which is the property this test protects.
    const response = await page.goto(`/tenants/${tenantId}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}/my-tasks$`));
    await expect(page.getByTestId("queue-row")).toHaveCount(0);
    await expect(page.getByTestId("tenant-facts")).toHaveCount(0);
  });
});

test.describe("a non-member", () => {
  test("gets the same answer for a real register as for one that does not exist", async ({
    page,
  }) => {
    const stranger = await createActor("reg-stranger");
    await createTenant(stranger, "Stranger Own Co", "voluntary");

    const owner = await createActor("reg-owner");
    const tenantId = await createTenant(owner, "Private Register Co", "mandatory");
    await seedActivity(tenantId, { purpose: "Nobody elses business" });

    await signIn(page, stranger);

    const theirs = await page.goto(`/tenants/${tenantId}/register`);
    const theirsBody = await page.content();
    const missing = await page.goto(`/tenants/${NONEXISTENT}/register`);
    const missingText = (await page.locator("body").innerText()).trim();

    expect(theirs?.status()).toBe(404);
    expect(missing?.status()).toBe(404);
    expect(theirsBody).not.toContain("Nobody elses business");
    expect(theirsBody).not.toContain("Private Register Co");

    await page.goto(`/tenants/${tenantId}/register`);
    expect((await page.locator("body").innerText()).trim()).toBe(missingText);
  });

  test("an anonymous visitor is asked to sign in", async ({ page }) => {
    const owner = await createActor("reg-anon-owner");
    const tenantId = await createTenant(owner, "Anon Register Co", "contractual");
    await seedActivity(tenantId, { purpose: "Hidden from the world" });

    await page.goto(`/tenants/${tenantId}/register`);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(await page.content()).not.toContain("Hidden from the world");
  });
});
