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

  // A workspace they are only staff in is NOT in this describe block any more:
  // staff hold a live membership, so (task N1) this route redirects them to
  // their own `/my-tasks` landing page instead of refusing them. Redirecting a
  // member who already knows the workspace exists leaks nothing; the "refuse
  // identically to a nonexistent tenant" property below is specifically for
  // callers with NO live membership at all. See "staff access" further down
  // for the staff-specific coverage (redirected, and the DPO dashboard itself
  // never rendered).

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

test.describe("staff access", () => {
  test("redirects a staff member away from the DPO workspace, never leaves them on it", async ({
    page,
  }) => {
    const staff = await createActor("tv-staff-closed");
    const employer = await createActor("tv-staff-closed-employer");
    const tenantId = await createTenant(employer, "Closed To Them Ltd", "mandatory");
    await employer.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: staff.email,
      p_tier: "staff",
    });

    await signIn(page, staff);

    for (const query of ["", "?view=dpo", "?view=employee"]) {
      // A staff member holds a live membership here, so (task N1) this is a
      // redirect to their own landing page, not a 404 — landing them
      // somewhere that already names their own workspace discloses nothing
      // they did not already know. What must still hold is that the DPO
      // dashboard itself never renders, whatever query string was appended.
      const response = await page.goto(`/tenants/${tenantId}${query}`);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}/my-tasks$`));
      await expect(page.getByTestId("queue-row")).toHaveCount(0);
      await expect(page.getByTestId("tenant-facts")).toHaveCount(0);
    }
  });

  test("a non-member still gets the same 404 as a nonexistent tenant", async ({ page }) => {
    // The distinction task N1 asks for made explicit: redirecting a NON-member
    // would confirm a workspace exists that they hold no membership in at all.
    // Only a live member (staff, here) is ever redirected.
    const stranger = await createActor("tv-staff-closed-stranger");
    await createTenant(stranger, "Strangers Own Ltd", "voluntary");

    const employer = await createActor("tv-staff-closed-employer-2");
    const employerTenant = await createTenant(employer, "Still Closed Ltd", "mandatory");

    await signIn(page, stranger);

    const missing = await refusal(page, `/tenants/${NONEXISTENT}`);
    const foreign = await refusal(page, `/tenants/${employerTenant}`);

    expect(foreign.status).toBe(404);
    await expectIdentical(foreign, missing, ["Still Closed Ltd", employer.email]);
  });

  test("does not render a DPO/employee view switch", async ({ page }) => {
    const dpo = await createActor("tv-no-toggle");
    const tenantId = await createTenant(dpo, "No Toggle Ltd", "contractual");

    await signIn(page, dpo);
    await page.goto(`/tenants/${tenantId}`);

    await expect(page.getByTestId("view-dpo")).toHaveCount(0);
    await expect(page.getByTestId("view-employee")).toHaveCount(0);
    await expect(page.getByTestId("employee-preview")).toHaveCount(0);
  });
});
