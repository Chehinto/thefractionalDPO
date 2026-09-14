/**
 * Fractional DPO portfolio dashboard.
 *
 * The dashboard is allowed to show client workspaces and aggregate work counts.
 * It must not surface source-level details such as software names, vendor names,
 * source excerpts or staff emails. Those belong inside the tenant workspace.
 */

import { expect, test, type Page } from "@playwright/test";
import { seedAiSuggestion } from "../support/ai-suggestion-fixtures";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

test("lists only the workspaces the caller is Active DPO of", async ({ page }) => {
  const dpo = await createActor("e2e-pf-dpo");
  const mine = await createTenant(dpo, "Northwind Retail", "contractual");

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
  await expect(page.getByTestId("create-tenant")).toBeVisible();

  expect(await page.content()).not.toContain("Someone Elses Company");
  expect(await page.content()).not.toContain(employerTenant);
});

test("shows aggregate dashboard work without leaking detected vendor names", async ({ page }) => {
  const dpo = await createActor("e2e-pf-aggregate");
  const tenantId = await createTenant(dpo, "Aggregate Client Ltd", "mandatory");
  await seedAiSuggestion(tenantId, {
    title: "SessionCam likely needs review",
    response_text: "SessionCam appears in an accounting export and may process behavioural data.",
    source_excerpt: "SESSIONCAM monthly platform subscription",
    source_label: "Xero accounting payment signal",
  });

  await signIn(page, dpo);

  const summaries = page.getByTestId("dashboard-summary");
  await expect(summaries.first()).toContainText("AI suggestion");
  await expect(summaries.first()).toContainText("Review suggestions");

  const html = await page.content();
  expect(html).not.toContain("SessionCam");
  expect(html).not.toContain("SESSIONCAM");
  expect(html).not.toContain("behavioural data");
});

test("creates a new tenant from the portfolio", async ({ page }) => {
  const dpo = await createActor("e2e-pf-create");
  await createTenant(dpo, "Existing Client Ltd", "voluntary");
  const clientName = `New Client ${Date.now()} Ltd`;

  await signIn(page, dpo);
  await page.getByTestId("create-tenant").click();
  await page.getByTestId("new-tenant-name").fill(clientName);
  await page.getByLabel(/customer contract or questionnaire/i).check();
  await page.getByTestId("submit-new-tenant").click();

  await expect(page.getByTestId("tenant-name")).toHaveText(clientName);

  const { data } = await adminClient()
    .from("tenants")
    .select("id, legal_basis")
    .eq("name", clientName)
    .single();
  expect(data!.legal_basis).toBe("contractual");
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
  await expect(page.getByTestId("create-first-tenant")).toBeVisible();
  expect(await page.content()).not.toContain("Employs Them Ltd");
});
