/**
 * The tier-3 vendor round-trip, end to end.
 *
 * `/s/[token]` is the only page in this product served to someone with no
 * account and no session, so this spec is as much about what a link CANNOT do
 * as about the happy path: reach a second workspace, survive revocation, or be
 * guessed. Assertions are behaviour and state — rendered content, HTTP status,
 * and rows in the database — never source text.
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

/** An approved questionnaire with questions — the only kind that can be sent. */
async function sendableQuestionnaire(owner: Actor, tenantId: string, vendor = "ScreenCo") {
  const { data } = await owner.client
    .from("vendor_questionnaire")
    .insert({
      tenant_id: tenantId,
      vendor_name: vendor,
      rationale: "Criminal record checks involve Art. 10 data",
      created_by: owner.personId,
    })
    .select("id")
    .single();
  const id = data!.id as string;

  await owner.client.from("vendor_questionnaire_question").insert([
    {
      tenant_id: tenantId,
      questionnaire_id: id,
      position: 1,
      question: "How long do you retain candidate results?",
      why_needed: "The retention field on the register is unevidenced",
      confidence_score: 80,
    },
    {
      tenant_id: tenantId,
      questionnaire_id: id,
      position: 2,
      question: "Do you transfer data outside the UK or EEA?",
      why_needed: "Needed for an Art. 44 transfer assessment",
      confidence_score: 80,
    },
  ]);

  await owner.client.rpc("approve_vendor_questionnaire", {
    p_caller_person_id: owner.personId,
    p_questionnaire_id: id,
  });
  return id;
}

/** Issue a link through the UI and return the one-time URL it shows. */
async function issueLink(page: Page, tenantId: string, label = "Acme security team") {
  await page.goto(`/tenants/${tenantId}/links`);
  await page.getByTestId("link-label-input").fill(label);
  await page.getByTestId("issue-link").click();

  const url = await page.getByTestId("issued-link-url").textContent();
  expect(url).toBeTruthy();
  return new URL(url!).pathname;
}

test("a vendor answers a questionnaire through a link, and the DPO sees the trail", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("link-dpo");
  const tenantId = await createTenant(dpo, "Link Round Trip Ltd", "contractual");
  await sendableQuestionnaire(dpo, tenantId);

  await signIn(page, dpo);
  const linkPath = await issueLink(page, tenantId);

  // A genuinely separate browser context: no cookies, no session, nothing
  // carried over from the DPO. This is what the vendor actually is.
  const vendorContext = await browser.newContext();
  const vendorPage = await vendorContext.newPage();

  await vendorPage.goto(linkPath);
  await expect(vendorPage.getByTestId("scoped-heading")).toContainText("Link Round Trip Ltd");
  await expect(vendorPage.getByTestId("scoped-question")).toHaveCount(2);

  // The vendor sees the questions and why they are asked — and nothing of the
  // register, the DPIA, or the company's own notes.
  await expect(vendorPage.getByTestId("scoped-why-needed").first()).toContainText("retention");

  await vendorPage.getByTestId("scoped-answer-input").first().fill("Thirty days after completion");
  await vendorPage.getByTestId("scoped-answer-submit").first().click();
  await expect(vendorPage.getByTestId("answer-saved")).toBeVisible();
  await expect(vendorPage.getByTestId("scoped-answer-recorded").first()).toBeVisible();

  // The answer is returned evidence, not a register entry: it lands raw, with
  // the link recorded against it as provenance.
  const { data: responses } = await adminClient()
    .from("vendor_questionnaire_response")
    .select("answer, scoped_access_grant_id")
    .eq("tenant_id", tenantId);
  expect(responses).toHaveLength(1);
  expect(responses![0]!.answer).toBe("Thirty days after completion");
  expect(responses![0]!.scoped_access_grant_id).not.toBeNull();

  // Back on the DPO's side, the log says it was opened and answered.
  await page.goto(`/tenants/${tenantId}/links`);
  await expect(page.getByTestId("link-state-live")).toBeVisible();
  const log = page.getByTestId("link-log-entry");
  await expect(log.filter({ hasText: "Opened" }).first()).toBeVisible();
  await expect(log.filter({ hasText: "Answered" }).first()).toBeVisible();

  await vendorContext.close();
});

test("revoking a link stops it on the very next request, and records the attempt", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("link-revoke-dpo");
  const tenantId = await createTenant(dpo, "Revoke Ltd", "mandatory");
  await sendableQuestionnaire(dpo, tenantId);

  await signIn(page, dpo);
  const linkPath = await issueLink(page, tenantId, "Contractor to be cut off");

  const vendorContext = await browser.newContext();
  const vendorPage = await vendorContext.newPage();
  await vendorPage.goto(linkPath);
  await expect(vendorPage.getByTestId("scoped-question")).toHaveCount(2);

  await page.goto(`/tenants/${tenantId}/links`);
  await page.getByTestId("revoke-link").click();
  await expect(page.getByTestId("link-state-revoked")).toBeVisible();

  // No grace period: the next request is refused, not the next session.
  const refused = await vendorPage.goto(linkPath);
  expect(refused?.status()).toBe(404);

  await page.reload();
  await expect(
    page.getByTestId("link-log-entry").filter({ hasText: "Refused" }).first()
  ).toBeVisible();

  await vendorContext.close();
});

test("a link reaches only its own workspace, and an unknown one reveals nothing", async ({
  page,
  browser,
}) => {
  const dpoA = await createActor("link-iso-a");
  const dpoB = await createActor("link-iso-b");
  const tenantA = await createTenant(dpoA, "Link Isolation A Ltd", "contractual");
  const tenantB = await createTenant(dpoB, "Link Isolation B Ltd", "contractual");
  await sendableQuestionnaire(dpoA, tenantA, "VendorA");
  await sendableQuestionnaire(dpoB, tenantB, "VendorB");

  await signIn(page, dpoA);
  const linkPath = await issueLink(page, tenantA);

  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();

  await strangerPage.goto(linkPath);
  await expect(strangerPage.getByTestId("scoped-heading")).toContainText("Link Isolation A Ltd");
  await expect(strangerPage.getByTestId("scoped-heading")).not.toContainText("Link Isolation B");

  // An unknown token, a malformed one and a revoked one are the same answer, so
  // the URL is not an oracle for whether a workspace exists.
  for (const bad of ["/s/" + "a".repeat(43), "/s/nope", "/s/../../tenants"]) {
    const response = await strangerPage.goto(bad);
    expect(response?.status()).toBe(404);
  }

  await stranger.close();
});

test("a staff member cannot open the DPO's link management", async ({ page }) => {
  const dpo = await createActor("link-staff-dpo");
  const tenantId = await createTenant(dpo, "Link Staff Ltd", "voluntary");
  const staff = await createActor("link-staff");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });

  await signIn(page, staff);
  const response = await page.goto(`/tenants/${tenantId}/links`);
  expect(response?.status()).toBe(404);

  // And cannot issue one by calling the API directly with their own session.
  const issued = await page.request.post(`/api/tenants/${tenantId}/scoped-links`, {
    data: { label: "Sneaky", questionnaireId: "00000000-0000-4000-8000-000000000000", days: 7 },
  });
  expect(issued.status()).toBe(404);
});

test("an auditor link shows the approved register and nothing around it", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("link-auditor-dpo");
  const tenantId = await createTenant(dpo, "Auditable Ltd", "mandatory");

  // One approved activity and one draft, so the page has something to exclude.
  const approved = await adminClient()
    .from("processing_activity")
    .insert({
      tenant_id: tenantId,
      purpose: "Payroll administration",
      purpose_confidence: "stated",
      purpose_evidence: "Quoted from the internal payroll contract",
      recipient_vendor: "Acme Payroll Ltd",
      recipient_vendor_confidence: "stated",
      role: "controller",
      data_categories_ordinary: ["employment_data"],
      data_categories_confidence: "stated",
      data_subjects: ["employees"],
      data_subjects_confidence: "stated",
      retention: "7 years from end of employment",
      retention_confidence: "stated",
    })
    .select("id")
    .single();
  await dpo.client.rpc("approve_processing_activity", {
    p_caller_person_id: dpo.personId,
    p_activity_id: approved.data!.id,
  });
  await adminClient().from("processing_activity").insert({
    tenant_id: tenantId,
    purpose: "Unapproved draft activity",
    purpose_confidence: "inferred",
    recipient_vendor: null,
    recipient_vendor_confidence: "unknown",
    role: "controller",
    data_categories_confidence: "unknown",
    data_subjects_confidence: "unknown",
    retention_confidence: "unknown",
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/links`);
  await page.getByTestId("link-purpose").selectOption("auditor_review");
  await page.getByTestId("link-label-input").fill("External auditor");
  await page.getByTestId("issue-link").click();

  const url = await page.getByTestId("issued-link-url").textContent();
  const linkPath = new URL(url!).pathname;

  const auditorContext = await browser.newContext();
  const auditorPage = await auditorContext.newPage();
  await auditorPage.goto(linkPath);

  await expect(auditorPage.getByTestId("scoped-heading")).toContainText("Auditable Ltd");
  await expect(auditorPage.getByTestId("scoped-register-row")).toHaveCount(1);
  await expect(auditorPage.getByTestId("scoped-register-purpose")).toContainText(
    "Payroll administration"
  );

  // The draft, the evidence quote and the confidence tags are all absent.
  const body = await auditorPage.locator("body").innerText();
  expect(body).not.toContain("Unapproved draft activity");
  expect(body).not.toContain("Quoted from the internal payroll contract");
  expect(body).not.toContain("inferred");

  // And an auditor link cannot be pointed at the questionnaire door.
  await expect(auditorPage.getByTestId("scoped-answer-input")).toHaveCount(0);

  await auditorContext.close();
});
