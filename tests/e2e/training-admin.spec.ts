/**
 * The DPO's side of training: review, publish, send, track.
 *
 * Generation itself is not exercised here — it needs a provider key, and the
 * prompt and parser have their own unit tests. What this covers is everything
 * around it: that a draft reaches nobody, that publishing is attributed, and
 * that "send to everyone" actually means everyone.
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

/** A generated draft, as the AI path would leave it: unpublished, unreviewed. */
async function seedDraft(dpo: Actor, tenantId: string) {
  const { data: module } = await adminClient()
    .from("training_module")
    .insert({
      tenant_id: tenantId,
      title: "Spotting and reporting a breach",
      body: "If you send something to the wrong person, tell the DPO the same day.",
      estimated_minutes: 6,
      source: "ai_generated",
      model_name: "claude-sonnet-5",
      created_by: dpo.personId,
    })
    .select("id")
    .single();

  const { data: questions } = await adminClient()
    .from("training_question")
    .insert(
      [1, 2, 3, 4].map((position) => ({
        tenant_id: tenantId,
        module_id: module!.id,
        position,
        question: `Scenario ${position}: what do you do first?`,
        options: ["Say nothing", "Tell the DPO the same day"],
      }))
    )
    .select("id");

  await adminClient().from("training_answer_key").insert(
    (questions ?? []).map((q) => ({
      question_id: q.id,
      tenant_id: tenantId,
      correct_index: 1,
      explanation: "Telling them the same day is what starts the clock.",
    }))
  );
  return module!.id as string;
}

test("a draft reaches nobody until the DPO publishes it, and then carries their name", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("tadmin-dpo");
  const staff = await createActor("tadmin-staff");
  const tenantId = await createTenant(dpo, "Training Admin Ltd", "contractual");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  await seedDraft(dpo, tenantId);

  // The staff member sees nothing while it is a draft.
  const staffContext = await browser.newContext();
  const staffPage = await staffContext.newPage();
  await signIn(staffPage, staff);
  await staffPage.goto(`/tenants/${tenantId}/training`);
  await expect(staffPage.getByTestId("training-empty")).toBeVisible();

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/training-admin`);
  await expect(page.getByTestId("draft-module-row")).toHaveCount(1);
  await expect(page.getByTestId("draft-module-row")).toContainText("Drafted by AI");
  await expect(page.getByTestId("no-published-modules")).toBeVisible();

  await page.getByTestId("publish-module").click();
  await expect(page.getByTestId("published-module")).toHaveCount(1);

  // Publishing is the review act, so it is attributed.
  const { data } = await adminClient()
    .from("training_module")
    .select("published, reviewed_by")
    .eq("tenant_id", tenantId)
    .single();
  expect(data).toEqual({ published: true, reviewed_by: dpo.personId });

  // Now the staff member can see it.
  await staffPage.reload();
  await expect(staffPage.getByTestId("training-module-row")).toHaveCount(1);

  await staffContext.close();
});

test("send to everyone assigns every member once, and says so if they all have it", async ({
  page,
}) => {
  const dpo = await createActor("tsend-dpo");
  const staffA = await createActor("tsend-a");
  const staffB = await createActor("tsend-b");
  const tenantId = await createTenant(dpo, "Training Send Ltd", "mandatory");
  for (const person of [staffA, staffB]) {
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: person.email,
      p_tier: "staff",
    });
  }
  const moduleId = await seedDraft(dpo, tenantId);
  await dpo.client.rpc("publish_training_module", {
    p_caller_person_id: dpo.personId,
    p_module_id: moduleId,
  });

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/training-admin`);
  await page.getByTestId("send-to-everyone").click();

  // The DPO plus both staff.
  await expect(page.getByTestId("training-sent")).toContainText("3 people");

  // Pressing it twice must not hand anyone a second copy.
  await page.getByTestId("send-to-everyone").click();
  await expect(page.getByTestId("training-sent")).toContainText("already has this one");

  const { data } = await adminClient()
    .from("assignment")
    .select("assignee_id")
    .eq("training_module_id", moduleId);
  expect(data).toHaveLength(3);
});

test("completion lists everyone, including the people who have not started", async ({
  page,
  browser,
}) => {
  const dpo = await createActor("ttrack-dpo");
  const doer = await createActor("ttrack-doer");
  const idler = await createActor("ttrack-idler");
  const tenantId = await createTenant(dpo, "Training Tracking Ltd", "voluntary");
  for (const person of [doer, idler]) {
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: person.email,
      p_tier: "staff",
    });
  }
  const moduleId = await seedDraft(dpo, tenantId);
  await dpo.client.rpc("publish_training_module", {
    p_caller_person_id: dpo.personId,
    p_module_id: moduleId,
  });

  // One person passes; one fails; one never starts.
  const doerContext = await browser.newContext();
  const doerPage = await doerContext.newPage();
  await signIn(doerPage, doer);
  await doerPage.goto(`/tenants/${tenantId}/training?module=${moduleId}`);
  for (const position of [1, 2, 3, 4]) {
    await doerPage.getByTestId(`answer-${position}-1`).check();
  }
  await doerPage.getByTestId("submit-training").click();
  await expect(doerPage.getByTestId("training-result")).toContainText("100%");

  await signIn(page, dpo);
  await page.goto(`/tenants/${tenantId}/training-admin`);

  // Three members listed, whatever they have or have not done — the point of
  // the record is answering who has NOT done it.
  await expect(page.getByTestId("completion-row")).toHaveCount(3);
  await expect(page.getByTestId("completion-summary")).toContainText("1 of 3 passed");
  await expect(
    page.getByTestId("completion-row").filter({ hasText: "Not started" })
  ).toHaveCount(2);

  await doerContext.close();
});

test("90% means one wrong answer in four is a retake", async ({ page }) => {
  const dpo = await createActor("tpass-dpo");
  const staff = await createActor("tpass-staff");
  const tenantId = await createTenant(dpo, "Training Pass Mark Ltd", "voluntary");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  const moduleId = await seedDraft(dpo, tenantId);
  await dpo.client.rpc("publish_training_module", {
    p_caller_person_id: dpo.personId,
    p_module_id: moduleId,
  });

  await signIn(page, staff);
  await page.goto(`/tenants/${tenantId}/training?module=${moduleId}`);
  await page.getByTestId("answer-1-0").check();
  for (const position of [2, 3, 4]) {
    await page.getByTestId(`answer-${position}-1`).check();
  }
  await page.getByTestId("submit-training").click();

  // 75% is a good score and still a retake. That is the rule, stated plainly.
  await expect(page.getByTestId("training-result")).toContainText("75%");
  await expect(page.getByTestId("training-result")).toContainText("pass mark is 90%");
  await expect(page.getByTestId("training-form")).toBeVisible();
});
