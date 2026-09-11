/**
 * The single-tenant view.
 *
 * Two things are being checked here that the unit tests cannot reach: that the
 * queue on screen holds only this workspace's items, and that every way of not
 * being allowed in produces the SAME response as a workspace that does not
 * exist. The second is the security property — a response that distinguishes
 * "exists but not yours" from "no such thing" lets someone map other companies'
 * workspaces one request at a time.
 */

import { expect, test, type Page } from "@playwright/test";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

const NONEXISTENT = "00000000-0000-4000-8000-000000000000";

async function signIn(page: Page, actor: Actor) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(actor.email);
  await page.getByLabel("Password").fill(actor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("signed-in-as")).toContainText(actor.email);
}

/**
 * What a refusal actually reveals.
 *
 * Deliberately NOT a raw byte-compare of the HTML. Two dev-mode renders differ
 * in cache-busting `?v=` timestamps, a per-response random id and compile
 * artefacts that vary with which route was hit first — none of which depend on
 * whether the tenant exists, all of which make a byte-compare a flaky proxy for
 * the property. What is compared here is everything an attacker could actually
 * read a signal from: the status, the title, the visible text, and whether any
 * trace of the workspace appears anywhere in the payload.
 */
async function refusal(page: Page, url: string) {
  const response = await page.goto(url);
  return {
    status: response?.status() ?? 0,
    title: await page.title(),
    text: (await page.locator("body").innerText()).trim(),
    html: await page.content(),
  };
}

/** Assert two refusals are indistinguishable, and that neither leaks `secrets`. */
async function expectIdentical(
  a: Awaited<ReturnType<typeof refusal>>,
  b: Awaited<ReturnType<typeof refusal>>,
  secrets: string[]
) {
  expect(a.status).toBe(b.status);
  expect(a.title).toBe(b.title);
  expect(a.text).toBe(b.text);
  for (const secret of secrets) {
    expect(a.html).not.toContain(secret);
    expect(b.html).not.toContain(secret);
  }
}

test("shows only this workspace's queue, not another's", async ({ page }) => {
  const dpo = await createActor("tv-dpo");
  const first = await createTenant(dpo, "Northwind Retail", "contractual");
  const second = await createTenant(dpo, "Meridian Logistics", "mandatory");

  // A distinctive item in the OTHER workspace this same DPO also runs. It must
  // not appear here — being allowed into both is not permission to mix them.
  await dpo.client.rpc("add_member", {
    p_tenant_id: second,
    p_email: `only-in-meridian-${Date.now()}@example.test`,
    p_tier: "staff",
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${first}`);

  await expect(page.getByTestId("tenant-name")).toHaveText("Northwind Retail");
  const html = await page.content();
  expect(html).not.toContain("Meridian Logistics");
  expect(html).not.toContain("only-in-meridian");
  expect(html).not.toContain(second);

  // Northwind has one Active DPO and nothing else, so exactly one row.
  await expect(page.getByTestId("queue-row")).toHaveCount(1);
  await expect(page.getByTestId("queue-row")).toContainText("You are the only Active DPO");
});

test("reaches the workspace from the portfolio and back again", async ({ page }) => {
  const dpo = await createActor("tv-nav");
  const tenantId = await createTenant(dpo, "Navigable Ltd", "voluntary");

  await signIn(page, dpo);
  await page.getByRole("link", { name: "Navigable Ltd" }).click();

  await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}$`));
  await expect(page.getByTestId("tenant-name")).toHaveText("Navigable Ltd");

  await page.getByTestId("back-to-portfolio").click();
  await expect(page.getByTestId("workspace-card")).toHaveCount(1);
});

test.describe("a refusal is indistinguishable from a workspace that does not exist", () => {
  test("a foreign workspace and a nonexistent one answer identically", async ({ page }) => {
    const dpo = await createActor("tv-foreign-dpo");
    await createTenant(dpo, "Own Ltd", "voluntary");

    const stranger = await createActor("tv-stranger");
    const foreign = await createTenant(stranger, "Confidential Rival Ltd", "mandatory");

    await signIn(page, dpo);

    const missing = await refusal(page, `/tenants/${NONEXISTENT}`);
    const theirs = await refusal(page, `/tenants/${foreign}`);

    expect(theirs.status).toBe(404);
    await expectIdentical(theirs, missing, ["Confidential Rival Ltd", stranger.email]);
  });

  test("a workspace they are only staff in answers the same way", async ({ page }) => {
    // §4 tier 2: staff never see the register or a DPIA. Not seeing this screen
    // is the same rule, and the refusal must not hint that a better tier exists.
    const staff = await createActor("tv-staff");
    await createTenant(staff, "Their Own Ltd", "voluntary");

    const employer = await createActor("tv-employer");
    const employerTenant = await createTenant(employer, "Employs Them Ltd", "contractual");
    await employer.client.rpc("add_member", {
      p_tenant_id: employerTenant,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    const missing = await refusal(page, `/tenants/${NONEXISTENT}`);
    const employerView = await refusal(page, `/tenants/${employerTenant}`);

    expect(employerView.status).toBe(404);
    await expectIdentical(employerView, missing, ["Employs Them Ltd", employer.email]);
  });

  test("a workspace they only hold external access to answers the same way", async ({ page }) => {
    const reviewer = await createActor("tv-reviewer");
    await createTenant(reviewer, "Reviewer Own Ltd", "voluntary");

    const audited = await createActor("tv-audited");
    const auditedTenant = await createTenant(audited, "Under Audit Ltd", "mandatory");
    await audited.client.rpc("add_member", {
      p_tenant_id: auditedTenant,
      p_email: reviewer.email,
      p_tier: "external_scoped",
    });

    await signIn(page, reviewer);

    const missing = await refusal(page, `/tenants/${NONEXISTENT}`);
    const auditedView = await refusal(page, `/tenants/${auditedTenant}`);

    expect(auditedView.status).toBe(404);
    await expectIdentical(auditedView, missing, ["Under Audit Ltd", audited.email]);
  });

  test("stops answering the moment the membership is revoked", async ({ page }) => {
    const dpo = await createActor("tv-revoked");
    const tenantId = await createTenant(dpo, "About To Lose It Ltd", "contractual");

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);
    await expect(page.getByTestId("tenant-name")).toHaveText("About To Lose It Ltd");

    const { data: membership } = await adminClient()
      .from("memberships")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("person_id", dpo.personId)
      .is("active_to", null)
      .single();
    // Through the RPC, not a direct column write: the guard trigger refuses an
    // `active_to` in the past, and a JS timestamp is always a moment behind the
    // transaction's now(). `revoke_membership` stamps it server-side, which is
    // exactly why it exists.
    const { error } = await dpo.client.rpc("revoke_membership", {
      p_membership_id: membership!.id,
    });
    expect(error).toBeNull();

    // Same session, same token, no reload trick. §4 gives revocation no grace
    // period, and the page must go from rendering to "no such thing".
    const after = await refusal(page, `/tenants/${tenantId}`);
    const missing = await refusal(page, `/tenants/${NONEXISTENT}`);
    expect(after.status).toBe(404);
    await expectIdentical(after, missing, ["About To Lose It Ltd"]);
  });

  test("an anonymous visitor is asked to sign in, identically for every id", async ({ page }) => {
    const dpo = await createActor("tv-anon");
    const real = await createTenant(dpo, "Real But Hidden Ltd", "voluntary");

    const realPrompt = await refusal(page, `/tenants/${real}`);
    const fakePrompt = await refusal(page, `/tenants/${NONEXISTENT}`);

    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expectIdentical(realPrompt, fakePrompt, ["Real But Hidden Ltd", dpo.email]);
  });
});

test.describe("the queue on this screen", () => {
  test("orders by what runs out first and flags the blocking dependency", async ({ page }) => {
    const dpo = await createActor("tv-queue");
    const tenantId = await createTenant(dpo, "Busy Ltd", "mandatory");

    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: `never-in-${Date.now()}@example.test`,
      p_tier: "staff",
    });
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);

    const clocks = await page.getByTestId("queue-clock").allTextContents();
    expect(clocks[0]).toMatch(/^Purged in \d+d$/);
    const dated = clocks
      .map((c) => c.match(/^Purged in (\d+)d$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => Number(m[1]));
    expect([...dated].sort((a, b) => a - b)).toEqual(dated);

    await expect(page.getByTestId("blocked-by")).toContainText("Workspace is read-only");
    await expect(page.getByTestId("dependency-note")).toContainText("cannot move until");
  });

  test("filter chips narrow the list without losing the dependency note", async ({ page }) => {
    const dpo = await createActor("tv-filter");
    const tenantId = await createTenant(dpo, "Filterable Ltd", "contractual");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: `unclaimed-${Date.now()}@example.test`,
      p_tier: "staff",
    });
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);

    const everything = await page.getByTestId("queue-row").count();
    expect(everything).toBe(3);

    await page.getByTestId("filter-you").click();
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
    await expect(page.getByTestId("queue-row")).toContainText("You are the only Active DPO");

    await page.getByTestId("filter-outside").click();
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
    await expect(page.getByTestId("queue-row")).toContainText("Workspace is read-only");

    // The dependency is a fact about the workspace, so it survives filtering.
    await expect(page.getByTestId("dependency-note")).toBeVisible();

    await page.getByTestId("filter-everything").click();
    await expect(page.getByTestId("queue-row")).toHaveCount(everything);
  });

  test("an unrecognised filter shows everything rather than erroring", async ({ page }) => {
    const dpo = await createActor("tv-badfilter");
    const tenantId = await createTenant(dpo, "Bad Filter Ltd", "voluntary");

    await signIn(page, dpo);
    const response = await page.goto(`/tenants/${tenantId}?filter=../../etc/passwd`);

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("queue-row")).toHaveCount(1);
  });
});

test.describe("the view toggle, on the same rules as the portfolio", () => {
  test("employee view drops the queue and the facts, and fetches nothing", async ({ page }) => {
    const dpo = await createActor("tv-toggle");
    const tenantId = await createTenant(dpo, "Toggled Ltd", "mandatory");
    await adminClient().from("tenants").update({ status: "read_only" }).eq("id", tenantId);

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);
    await expect(page.getByTestId("queue-row")).not.toHaveCount(0);

    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));

    await page.getByTestId("view-employee").click();
    await expect(page.getByTestId("employee-preview")).toBeVisible();

    // Nothing DPO-shaped is on screen.
    await expect(page.getByTestId("queue-row")).toHaveCount(0);
    await expect(page.getByTestId("tenant-facts")).toHaveCount(0);

    // No query stands behind the preview, so there is nothing fetched to leak.
    expect(requests.filter((url) => /\/rest\/v1\/|\/api\//.test(url))).toEqual([]);

    // What the SERVER sends for this URL is the property that matters. After a
    // client-side navigation the previous page's RSC payload is still sitting
    // in the document — that is this DPO's own data being re-rendered in their
    // own tab, not a leak, but it means the raw DOM is the wrong thing to
    // assert on. A fresh request is what a staff member's browser would make.
    const fresh = await page.goto(`/tenants/${tenantId}?view=employee`);
    expect(fresh?.status()).toBe(200);
    const serverHtml = await page.content();
    expect(serverHtml).not.toContain("Workspace is read-only");
    expect(serverHtml).not.toContain("DPO basis");
    expect(serverHtml).not.toContain("Billing");
  });

  test("cannot be widened into an access switch by URL parameters", async ({ page }) => {
    const dpo = await createActor("tv-toggle-params");
    const tenantId = await createTenant(dpo, "Params Ltd", "contractual");
    await signIn(page, dpo);

    for (const query of [
      "?view=employee&filter=you",
      "?view=employee&tier=active_dpo",
      "?view=employee&scope=all",
    ]) {
      await page.goto(`/tenants/${tenantId}${query}`);
      await expect(page.getByTestId("employee-preview")).toBeVisible();
      await expect(page.getByTestId("queue-row")).toHaveCount(0);
      expect(await page.content()).not.toContain("DPO basis");
    }
  });

  test("does not let a staff member into the page in either view", async ({ page }) => {
    // The toggle renders less, never more. It cannot be used to get in, because
    // the access decision happens before either view is chosen.
    const staff = await createActor("tv-toggle-staff");
    const employer = await createActor("tv-toggle-employer");
    const tenantId = await createTenant(employer, "Closed To Them Ltd", "mandatory");
    await employer.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    for (const query of ["", "?view=dpo", "?view=employee"]) {
      const response = await page.goto(`/tenants/${tenantId}${query}`);
      expect(response?.status()).toBe(404);
      expect(await page.content()).not.toContain("Closed To Them Ltd");
    }
  });
});
