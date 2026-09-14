/**
 * Tier 2, end to end (design resume §4).
 *
 * The multi-page journey §4 describes: a DPO asks one member something, that
 * member signs in, finds it, answers it, and the DPO sees the answer. This is
 * the kind of thing CLAUDE.md reserves Playwright for — it spans two people,
 * two sessions and four screens, and no unit test can express it.
 *
 * The second half is the isolation that makes tier 2 safe to hand to staff:
 * being asked one question must not open the register, and must not reveal
 * that anyone else was asked anything.
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

async function assignVia(
  page: Page,
  tenantId: string,
  assigneeEmail: string,
  title: string,
  body: string
) {
  await page.goto(`/tenants/${tenantId}/roster`);
  // Chosen by name, never left to the default. The roster lists every live
  // member including the DPO, so "the first option" is not a person this test
  // can name — and silently assigning to the wrong one would still look green
  // on the DPO's own screen, which sees everybody's assignments.
  await page.getByTestId("assign-assignee").selectOption({ label: assigneeEmail });
  await page.getByTestId("assign-title").fill(title);
  await page.getByTestId("assign-body").fill(body);
  await page.getByTestId("assign-why").fill("The register has no evidenced retention period.");
  await page.getByTestId("submit-assignment").click();
  await expect(page.getByTestId("roster-assignment-title").filter({ hasText: title })).toBeVisible();
}

test("a DPO asks a staff member something and gets an answer back", async ({ page, browser }) => {
  const dpo = await createActor("tier2-dpo");
  const staff = await createActor("tier2-staff");
  const tenantId = await createTenant(dpo, "Tier Two Ltd", "contractual");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, dpo);
  await assignVia(
    page,
    tenantId,
    staff.email,
    "Retention on candidate CVs",
    "How long do we keep CVs after a role is filled?"
  );
  await expect(page.getByTestId("roster-assignment-pending")).toBeVisible();

  // The staff member, in their own browser: a separate session entirely.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signIn(staffPage, staff);

  // They find it from the portfolio without being sent a link — before this,
  // a staff member signed in to an empty screen with nowhere to go. The
  // portfolio itself names no workspace it does not run; the names are on
  // /tasks, which is not a portfolio.
  await expect(staffPage.getByTestId("tasks-elsewhere")).toBeVisible();
  expect(await staffPage.content()).not.toContain("Tier Two Ltd");
  await staffPage.getByTestId("open-tasks").click();
  await expect(staffPage.getByTestId("tasks-workspace-name")).toContainText("Tier Two Ltd");
  await staffPage.getByTestId("open-workspace-tasks").click();

  await expect(staffPage.getByTestId("task")).toHaveCount(1);
  await expect(staffPage.getByTestId("task-title")).toContainText("Retention on candidate CVs");
  await expect(staffPage.getByTestId("task-why")).toContainText("no evidenced retention");

  await staffPage.getByTestId("task-response-input").fill("Twelve months, per the recruitment policy");
  await staffPage.getByTestId("task-respond").click();
  await expect(staffPage.getByTestId("task-status")).toContainText("Answered");

  // Back on the DPO's side.
  await page.goto(`/tenants/${tenantId}/roster`);
  await expect(page.getByTestId("roster-assignment-response")).toContainText(
    "Twelve months, per the recruitment policy"
  );
  await expect(page.getByTestId("roster-member-state").first()).toContainText("All answered");

  await staffContext.close();
});

test("the roster lists members with nothing asked, so unanswered is visible", async ({ page }) => {
  const dpo = await createActor("tier2-roster-dpo");
  const asked = await createActor("tier2-asked");
  const unasked = await createActor("tier2-unasked");
  const tenantId = await createTenant(dpo, "Roster Coverage Ltd", "mandatory");

  for (const staff of [asked, unasked]) {
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
  }

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/roster`);

  // Three live members: the DPO and both staff. The one nobody asked is the
  // reason §4 insists the roster is maintained rather than accumulated.
  await expect(page.getByTestId("roster-member")).toHaveCount(3);
  await expect(page.getByTestId("roster-member-state").filter({ hasText: "Nothing asked" })).toHaveCount(3);
});

test("being asked something does not open the register or another member's tasks", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("tier2-iso-dpo");
  const alice = await createActor("tier2-alice");
  const bob = await createActor("tier2-bob");
  const tenantId = await createTenant(dpo, "Tier Two Isolation Ltd", "contractual");

  for (const staff of [alice, bob]) {
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });
  }

  await signIn(page, dpo);
  await assignVia(page, tenantId, alice.email, "For Alice only", "A question meant for Alice");

  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await signIn(bobPage, bob);
  await bobPage.goto(`/tenants/${tenantId}/my-tasks`);

  // Bob is a member, so the page loads — and shows him nothing, because
  // nothing was pushed to him.
  await expect(bobPage.getByTestId("tasks-empty")).toBeVisible();
  expect(await bobPage.locator("body").innerText()).not.toContain("For Alice only");

  // The DPO-only screens stay shut, including the roster that would have shown
  // him what everyone else was asked.
  // Fetched rather than navigated to. `page.request` shares the browser
  // context's cookies, so these carry Bob's real session — and back-to-back
  // navigations into Next's not-found pages abort each other, which reads as a
  // network error rather than the 404 being asserted.
  for (const path of ["", "/roster", "/links", "/ai-review"]) {
    const response = await bobPage.request.get(`/tenants/${tenantId}${path}`);
    expect(response.status()).toBe(404);
  }

  // `/register` is deliberately NOT in that list. It admits any member and lets
  // RLS decide what they see, so that a staff member can read the one activity
  // somebody shared with them. Nothing has been shared with Bob, so the rule
  // has to show up as an empty register rather than a closed door — which is
  // the difference between the policy working and the route merely hiding it.
  const register = await bobPage.request.get(`/tenants/${tenantId}/register`);
  expect(register.status()).toBe(200);

  await bobPage.goto(`/tenants/${tenantId}/register`);
  await expect(bobPage.getByTestId("activity")).toHaveCount(0);

  await bobContext.close();
});
