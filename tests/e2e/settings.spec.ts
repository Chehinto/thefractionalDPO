/**
 * The two outbound settings, as a DPO experiences them (design resume §1).
 *
 * §1's rule that the toggles are "never bundled" is enforced in the schema and
 * again here, where a person actually makes the choice: two forms, two saves,
 * and changing one must leave the other exactly as it was.
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

test("the defaults are asymmetric, and each toggle saves on its own", async ({ page }) => {
  const dpo = await createActor("settings-dpo");
  const tenantId = await createTenant(dpo, "Settings Ltd", "contractual");

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/settings`);

  // Authorising us to act as the DPO is never assumed; the recommendation note
  // is the DPO's own client configuring their own message.
  await expect(page.getByTestId("setting-send-authorization-state")).toHaveText("Off");
  await expect(page.getByTestId("setting-recommendation-note-state")).toHaveText("On");

  // Turning the note off must not touch the authorisation, which is the whole
  // point of them being two columns rather than one preference.
  await page.getByTestId("setting-recommendation-note-toggle").click();
  await expect(page.getByTestId("settings-saved")).toBeVisible();
  await expect(page.getByTestId("setting-recommendation-note-state")).toHaveText("Off");
  await expect(page.getByTestId("setting-send-authorization-state")).toHaveText("Off");

  await page.getByTestId("setting-send-authorization-toggle").click();
  await expect(page.getByTestId("setting-send-authorization-state")).toHaveText("On");
  await expect(page.getByTestId("setting-recommendation-note-state")).toHaveText("Off");

  const { data } = await adminClient()
    .from("tenants")
    .select("platform_send_authorized, vendor_recommendation_note")
    .eq("id", tenantId)
    .single();
  expect(data).toEqual({ platform_send_authorized: true, vendor_recommendation_note: false });
});

test("a staff member cannot reach settings", async ({ page }) => {
  const dpo = await createActor("settings-staff-dpo");
  const tenantId = await createTenant(dpo, "Settings Closed Ltd", "mandatory");
  const staff = await createActor("settings-staff");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff);
  const response = await page.request.get(`/tenants/${tenantId}/settings`);
  expect(response.status()).toBe(404);
});

test("without authorisation, giving a vendor address does not send — it says why", async ({
  page,
}) => {
  const dpo = await createActor("send-unauth-dpo");
  const tenantId = await createTenant(dpo, "Unauthorised Send Ltd", "contractual");

  const { data: questionnaire } = await dpo.client
    .from("vendor_questionnaire")
    .insert({
      tenant_id: tenantId,
      vendor_name: "ScreenCo",
      rationale: "Criminal record checks involve Art. 10 data",
      created_by: dpo.personId,
    })
    .select("id")
    .single();
  await dpo.client.from("vendor_questionnaire_question").insert({
    tenant_id: tenantId,
    questionnaire_id: questionnaire!.id,
    position: 1,
    question: "How long do you retain candidate results?",
    why_needed: "Retention is unevidenced on the register",
    confidence_score: 80,
  });
  await dpo.client.rpc("approve_vendor_questionnaire", {
    p_caller_person_id: dpo.personId,
    p_questionnaire_id: questionnaire!.id,
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/links`);
  await page.getByTestId("link-label-input").fill("Acme security team");
  await page.getByTestId("vendor-contact-email").fill("security@acme.test");
  await page.getByTestId("issue-link").click();

  // The link is still issued — the DPO can always send it themselves — but
  // nothing went out under their name without their authorisation.
  await expect(page.getByTestId("issued-link-url")).toBeVisible();
  await expect(page.getByTestId("issued-link-not-sent")).toContainText("not authorized");

  const { data: sent } = await adminClient()
    .from("email_log")
    .select("id")
    .eq("tenant_id", tenantId);
  expect(sent).toEqual([]);
});
