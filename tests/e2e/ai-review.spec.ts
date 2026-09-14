/**
 * AI review inbox.
 *
 * Unit tests prove the RLS and approve function. These tests prove the product
 * surface keeps the AxioVendo rule visible: AI text, source excerpt, confidence
 * tag and confidence score are all on screen before a DPO can mark it reviewed.
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

test("a DPO reviews source-backed AI suggestions and marks them reviewed", async ({ page }) => {
  const dpo = await createActor("ai-review-dpo");
  const tenantId = await createTenant(dpo, "AI Review Co", "contractual");
  const suggestionId = await seedAiSuggestion(tenantId);

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}`);
  await page.getByTestId("open-ai-review").click();

  await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}/ai-review$`));
  await expect(page.getByTestId("ai-suggestion")).toHaveCount(1);
  await expect(page.getByTestId("ai-suggestion-title")).toContainText(
    "Review Slack as a likely processor"
  );
  await expect(page.getByTestId("ai-response")).toContainText("likely to process");
  await expect(page.getByTestId("source-excerpt")).toContainText("SLACK monthly team subscription");
  await expect(page.getByTestId("confidence-inferred")).toBeVisible();
  await expect(page.getByTestId("confidence-score")).toHaveText("76/100");

  await page.getByTestId("approve-ai-suggestion").click();

  await expect(page.getByTestId("ai-review-empty")).toBeVisible();
  const { data } = await adminClient()
    .from("ai_suggestion")
    .select("status, approved_by")
    .eq("id", suggestionId)
    .single();
  expect(data).toEqual({ status: "approved", approved_by: dpo.personId });
});

test("staff cannot open the DPO-only AI review inbox", async ({ page }) => {
  const dpo = await createActor("ai-review-staff-dpo");
  const tenantId = await createTenant(dpo, "AI Review Staff Closed Co", "mandatory");
  await seedAiSuggestion(tenantId, { title: "Hidden AI suggestion" });

  const staff = await createActor("ai-review-staff");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff);
  const response = await page.goto(`/tenants/${tenantId}/ai-review`);

  expect(response?.status()).toBe(404);
  expect(await page.content()).not.toContain("Hidden AI suggestion");
});
