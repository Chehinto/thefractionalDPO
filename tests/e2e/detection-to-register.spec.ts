/**
 * Detection all the way to the register (design resume §9).
 *
 * The loop that was open: an accounting export became a suggestion, a DPO
 * marked it reviewed, and the Article 30 register stayed empty because
 * approving a suggestion is only a stamp. This walks the whole path and
 * asserts the thing that makes it safe — what lands is a DRAFT.
 */

import { expect, test, type Page } from "@playwright/test";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";
import { seedAiSuggestion } from "../support/ai-suggestion-fixtures";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

test("a staff vendor request becomes a register draft, carrying what was stated", async ({
  page,
}) => {
  const dpo = await createActor("d2r-dpo");
  const staff = await createActor("d2r-staff");
  const tenantId = await createTenant(dpo, "Detection To Register Ltd", "contractual");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  // A colleague asks to use a vendor. This is the staff-safe doorway.
  await signIn(page, staff);
  await page.goto(`/tenants/${tenantId}/request-vendor`);
  await page.getByLabel("Vendor").fill("ScreenCo");
  await page
    .getByLabel("Why do you want to use them?")
    .fill("Run criminal record checks for regulated roles");
  await page.getByLabel("What data will they handle?").fill("Candidate identity and results");
  await page.getByTestId("submit-vendor-request").click();
  await expect(page.getByTestId("vendor-request-submitted")).toBeVisible();

  // The DPO picks it up in the review inbox and promotes it.
  const dpoContext = await page.context().browser()!.newContext();
  const dpoPage = await dpoContext.newPage();
  await signIn(dpoPage, dpo);
  await dpoPage.goto(`/tenants/${tenantId}/ai-review`);
  await dpoPage.getByTestId("add-to-register").first().click();

  // What the colleague actually said is carried over; what they did not say is
  // left for the DPO, and the page says which is which.
  await expect(dpoPage.getByTestId("promote-purpose")).toHaveValue(
    "Run criminal record checks for regulated roles"
  );
  await expect(dpoPage.getByTestId("promote-vendor")).toHaveValue("ScreenCo");
  await expect(dpoPage.getByTestId("promote-retention")).toHaveValue("");
  await expect(dpoPage.getByTestId("promote-unestablished")).toContainText("controller or processor");

  // Role is never defaulted, so submitting without it cannot succeed.
  await dpoPage.getByTestId("promote-role").selectOption("controller");
  await dpoPage.getByTestId("promote-submit").click();

  await expect(dpoPage).toHaveURL(new RegExp(`/tenants/${tenantId}/register$`));

  // It lands as a DRAFT. Approving it is still a separate human act.
  const { data } = await adminClient()
    .from("processing_activity")
    .select("purpose, recipient_vendor, role, status, retention, retention_confidence")
    .eq("tenant_id", tenantId);

  expect(data).toHaveLength(1);
  expect(data![0]).toMatchObject({
    purpose: "Run criminal record checks for regulated roles",
    recipient_vendor: "ScreenCo",
    role: "controller",
    status: "pending_dpo_review",
    retention: null,
    retention_confidence: "unknown",
  });

  await dpoContext.close();
});

test("a discovery signal prefills the vendor but never invents a purpose", async ({ page }) => {
  const dpo = await createActor("d2r-discovery-dpo");
  const tenantId = await createTenant(dpo, "Discovery Register Ltd", "mandatory");

  const { data: signal } = await adminClient()
    .from("software_discovery_signal")
    .insert({
      tenant_id: tenantId,
      source: "accounting_payment",
      source_name: "Xero",
      software_name: "Notion",
      vendor_name: "Notion Labs",
      signal_text: "NOTION.SO monthly workspace subscription",
      created_by: dpo.personId,
    })
    .select("id")
    .single();

  const suggestionId = await seedAiSuggestion(tenantId, {
    kind: "register_intake",
    title: "Review Notion as a likely processor",
  });
  await adminClient()
    .from("ai_suggestion")
    .update({ software_discovery_signal_id: signal!.id })
    .eq("id", suggestionId);

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/ai-review/${suggestionId}/to-register`);

  // The export names who was paid — that is stated. It does not say why the
  // software is used, so the purpose stays empty rather than being guessed.
  await expect(page.getByTestId("promote-vendor")).toHaveValue("Notion Labs");
  await expect(page.getByTestId("promote-purpose")).toHaveValue("");
  await expect(page.getByTestId("promote-unestablished")).toContainText(
    "Whether it touches personal data at all"
  );
});
