/**
 * Signup — an auth/session flow, which is one of the cases CLAUDE.md keeps
 * Playwright for. It needs a real browser because the sequence under test spans
 * an auth round-trip, a cookie-backed session, and a server route that depends
 * on that session already existing.
 *
 * The page itself is deliberately unstyled and will be redesigned, so nothing
 * here asserts on appearance — only on behaviour, roles and resulting state.
 */

import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { adminClient, createActor, createTenant } from "../support/tenancy-fixtures";

async function fillSignup(
  page: Page,
  fields: { email: string; password: string; company: string; basisLabel?: RegExp }
) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(fields.email);
  await page.getByLabel("Password").fill(fields.password);
  await page.getByLabel("Company name").fill(fields.company);
  if (fields.basisLabel) {
    await page.getByRole("radio", { name: fields.basisLabel }).check();
  }
}

test("signing up creates an account, a person and exactly one workspace", async ({ page }) => {
  const email = `e2e-signup-${randomUUID()}@example.test`;
  const company = `Signup Co ${randomUUID().slice(0, 8)}`;

  await fillSignup(page, {
    email,
    password: `pw-${randomUUID()}`,
    company,
    basisLabel: /legally required/i,
  });
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByTestId("signed-in-as")).toContainText(email);
  await expect(page.getByTestId("workspace-count")).toContainText("1 workspace");

  const { data: people } = await adminClient().from("people").select("id").eq("email", email);
  expect(people).toHaveLength(1);

  const { data: tenant } = await adminClient()
    .from("tenants")
    .select("id, legal_basis")
    .eq("name", company)
    .single();
  expect(tenant!.legal_basis).toBe("mandatory");

  // The creator is Active DPO of that workspace and of nothing else.
  const { data: memberships } = await adminClient()
    .from("memberships")
    .select("tenant_id, tier")
    .eq("person_id", people![0].id);
  expect(memberships).toEqual([{ tenant_id: tenant!.id, tier: "active_dpo" }]);
});

test("the legal-basis question cannot be skipped", async ({ page }) => {
  const email = `e2e-nobasis-${randomUUID()}@example.test`;
  const company = `No Basis Co ${randomUUID().slice(0, 8)}`;

  // Every other field filled; no radio chosen.
  await fillSignup(page, { email, password: `pw-${randomUUID()}`, company });
  await page.getByRole("button", { name: "Create account" }).click();

  // The form does not submit, so no account and no workspace come into being.
  // §6's answer is not something the product can fill in afterwards.
  await expect(page).toHaveURL(/\/signup$/);

  const { data: tenants } = await adminClient().from("tenants").select("id").eq("name", company);
  expect(tenants).toEqual([]);

  const { data: people } = await adminClient().from("people").select("id").eq("email", email);
  expect(people).toEqual([]);
});

test("a rostered colleague who signs up keeps their existing membership", async ({ page }) => {
  // The full §4 tier 2 journey in a browser: rostered first, signs up second,
  // and lands in the workspace they were already a member of rather than a
  // duplicate identity with no history.
  const dpo = await createActor("e2e-roster-dpo");
  const tenantId = await createTenant(dpo, "E2E Roster Co", "contractual");
  const email = `e2e-rostered-${randomUUID()}@example.test`;

  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: email,
    p_tier: "staff",
  });

  await fillSignup(page, {
    email,
    password: `pw-${randomUUID()}`,
    company: `Their Own Co ${randomUUID().slice(0, 8)}`,
    basisLabel: /voluntarily/i,
  });
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByTestId("signed-in-as")).toContainText(email);

  // One person row, not two.
  const { data: people } = await adminClient().from("people").select("id").eq("email", email);
  expect(people).toHaveLength(1);

  // They hold the roster membership they were given before signing up, plus
  // the workspace they just created for themselves.
  const { data: memberships } = await adminClient()
    .from("memberships")
    .select("tenant_id, tier")
    .eq("person_id", people![0].id);

  expect(memberships).toHaveLength(2);
  expect(memberships).toContainEqual({ tenant_id: tenantId, tier: "staff" });
});
