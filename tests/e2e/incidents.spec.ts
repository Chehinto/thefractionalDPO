/**
 * Logging a breach and seeing the clock (design resume §2.4).
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

/** `datetime-local` wants a local-time string with no zone. */
function localInput(offsetMs: number): string {
  const d = new Date(Date.now() + offsetMs - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

test("logging a breach starts a 72-hour clock from when you became aware", async ({ page }) => {
  const dpo = await createActor("inc-dpo");
  const tenantId = await createTenant(dpo, "Breach Ltd", "mandatory");

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/incidents`);
  await expect(page.getByTestId("incidents-empty")).toBeVisible();

  await page.getByTestId("incident-title-input").fill("Mailing list sent to the wrong recipient");
  await page
    .getByTestId("incident-description-input")
    .fill("A CSV of customer addresses went to an external contact.");
  await page.getByTestId("incident-discovered-input").fill(localInput(-2 * 3_600_000));
  await page.getByTestId("incident-affected-input").fill("400");
  await page.getByTestId("log-incident").click();

  await expect(page.getByTestId("incident")).toHaveCount(1);
  await expect(page.getByTestId("incident-clock")).toContainText("left to notify");

  const { data } = await adminClient()
    .from("incident")
    .select("discovered_at, authority_deadline, notifiability, status")
    .eq("tenant_id", tenantId)
    .single();

  expect(Date.parse(data!.authority_deadline as string)).toBe(
    Date.parse(data!.discovered_at as string) + 72 * 3_600_000
  );
  expect(data!.notifiability).toBe("not_assessed");
  expect(data!.status).toBe("open");
});

test("an old breach discovered today is due in 72 hours, not overdue", async ({ page }) => {
  const dpo = await createActor("inc-old-dpo");
  const tenantId = await createTenant(dpo, "Old Breach Ltd", "contractual");

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/incidents`);
  await page.getByTestId("incident-title-input").fill("Backup exposed since March");
  await page.getByTestId("incident-description-input").fill("Found during an access review.");
  // Happened long ago; discovered a moment ago. The clock runs from discovery.
  await page.getByTestId("incident-occurred-input").fill("2026-03-01T09:00");
  await page.getByTestId("incident-discovered-input").fill(localInput(-60_000));
  await page.getByTestId("log-incident").click();

  await expect(page.getByTestId("incident")).toHaveAttribute("data-clock", "running");
  await expect(page.getByTestId("incident-clock")).not.toContainText("closed");
});

test("an overdue breach says the window closed, not that a law was broken", async ({ page }) => {
  const dpo = await createActor("inc-overdue-dpo");
  const tenantId = await createTenant(dpo, "Overdue Ltd", "mandatory");

  await adminClient().from("incident").insert({
    tenant_id: tenantId,
    title: "Laptop lost",
    description: "Unencrypted laptop taken from a car.",
    discovered_at: new Date(Date.now() - 100 * 3_600_000).toISOString(),
    created_by: dpo.personId,
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/incidents`);

  await expect(page.getByTestId("incident")).toHaveAttribute("data-clock", "overdue");
  const clock = await page.getByTestId("incident-clock").innerText();
  expect(clock).toContain("closed");
  expect(clock).toContain("reasons for the delay");
});

test("a staff member cannot reach the breach register", async ({ page }) => {
  const dpo = await createActor("inc-staff-dpo");
  const tenantId = await createTenant(dpo, "Incident Closed Ltd", "voluntary");
  const staff = await createActor("inc-staff");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff);
  const response = await page.request.get(`/tenants/${tenantId}/incidents`);
  expect(response.status()).toBe(404);
});
