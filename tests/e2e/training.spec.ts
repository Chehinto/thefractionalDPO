/**
 * A staff member taking a training module (design resume §2.5).
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

async function seedModule(dpo: Actor, tenantId: string, published = true) {
  const { data: module } = await dpo.client
    .from("training_module")
    .insert({
      tenant_id: tenantId,
      title: "Handling personal data on email",
      body: "Check the recipient before attaching anything with names in it.",
      created_by: dpo.personId,
    })
    .select("id")
    .single();

  const { data: questions } = await dpo.client
    .from("training_question")
    .insert([
      {
        tenant_id: tenantId,
        module_id: module!.id,
        position: 1,
        question: "About to email a spreadsheet of customers. What first?",
        options: ["Send it", "Check the recipient and whether they need all of it"],
      },
      {
        tenant_id: tenantId,
        module_id: module!.id,
        position: 2,
        question: "You sent it to the wrong person. What now?",
        options: ["Say nothing", "Tell the DPO straight away"],
      },
    ])
    .select("id");

  await dpo.client.from("training_answer_key").insert(
    (questions ?? []).map((q) => ({
      question_id: q.id,
      tenant_id: tenantId,
      correct_index: 1,
      explanation: "The 72-hour clock starts when someone becomes aware.",
    }))
  );

  if (published) {
    // Publishing is the review act and is attributed, so it goes through the
    // function rather than a direct update — `published` is no longer in the
    // update grant.
    await dpo.client.rpc("publish_training_module", {
      p_caller_person_id: dpo.personId,
      p_module_id: module!.id,
    });
  }
  return module!.id as string;
}

test("a staff member reads a module, answers it, and the attempt is recorded", async ({ page }) => {
  const dpo = await createActor("train-e2e-dpo");
  const staff = await createActor("train-e2e-staff");
  const tenantId = await createTenant(dpo, "Training E2E Ltd", "voluntary");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  await seedModule(dpo, tenantId);

  await signIn(page, staff);
  await page.goto(`/tenants/${tenantId}/training`);
  await expect(page.getByTestId("training-module-state")).toContainText("Not started");

  await page.getByTestId("open-training-module").click();
  // The content is the point — §3's gap was a record of training with no
  // training in it.
  await expect(page.getByTestId("training-body")).toContainText("Check the recipient");
  await expect(page.getByTestId("training-question")).toHaveCount(2);

  await page.getByTestId("answer-1-1").check();
  await page.getByTestId("answer-2-1").check();
  await page.getByTestId("submit-training").click();

  await expect(page.getByTestId("training-result")).toContainText("100%");
  await expect(page.getByTestId("training-result")).toContainText("passed");

  const { data } = await adminClient()
    .from("training_attempt")
    .select("score, passed, person_id")
    .eq("tenant_id", tenantId);
  expect(data).toHaveLength(1);
  expect(data![0]).toMatchObject({ score: 100, passed: true, person_id: staff.personId });
});

test("a wrong answer does not pass, and the answers are never in the page", async ({ page }) => {
  const dpo = await createActor("train-fail-dpo");
  const staff = await createActor("train-fail-staff");
  const tenantId = await createTenant(dpo, "Training Fail Ltd", "mandatory");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  const moduleId = await seedModule(dpo, tenantId);

  await signIn(page, staff);
  await page.goto(`/tenants/${tenantId}/training?module=${moduleId}`);

  // The quiz would measure nothing if the key were reachable by the trainee.
  const html = await page.content();
  expect(html).not.toContain("correct_index");
  expect(html).not.toContain("72-hour clock starts");

  await page.getByTestId("answer-1-0").check();
  await page.getByTestId("answer-2-1").check();
  await page.getByTestId("submit-training").click();

  await expect(page.getByTestId("training-result")).toContainText("50%");
  await expect(page.getByTestId("training-result")).toContainText("pass mark is 90%");
});

test("an unpublished module is not offered to staff", async ({ page }) => {
  const dpo = await createActor("train-draft-dpo");
  const staff = await createActor("train-draft-staff");
  const tenantId = await createTenant(dpo, "Training Draft Ltd", "voluntary");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  await seedModule(dpo, tenantId, false);

  await signIn(page, staff);
  await page.goto(`/tenants/${tenantId}/training`);
  await expect(page.getByTestId("training-empty")).toBeVisible();
});
