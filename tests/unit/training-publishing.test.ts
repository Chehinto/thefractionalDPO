/**
 * Publishing and assigning training.
 *
 * The rules under test are the ones a page could forget: 90% to pass, under
 * ten minutes, and a human behind anything generated before staff read it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let staff: Actor;
let tenantId: string;

async function newModule(overrides: Record<string, unknown> = {}) {
  return dpo.client
    .from("training_module")
    .insert({
      tenant_id: tenantId,
      title: "Handling personal data on email",
      body: "Check the recipient before attaching anything with names in it.",
      estimated_minutes: 6,
      created_by: dpo.personId,
      ...overrides,
    })
    .select("id")
    .single();
}

async function addQuestion(moduleId: string, position = 1, withKey = true) {
  const { data } = await dpo.client
    .from("training_question")
    .insert({
      tenant_id: tenantId,
      module_id: moduleId,
      position,
      question: "You emailed the wrong attachment. What first?",
      options: ["Say nothing", "Tell the DPO straight away"],
    })
    .select("id")
    .single();

  if (withKey) {
    await dpo.client.from("training_answer_key").insert({
      question_id: data!.id,
      tenant_id: tenantId,
      correct_index: 1,
      explanation: "Telling them starts the clock.",
    });
  }
  return data!.id as string;
}

beforeAll(async () => {
  dpo = await createActor("tpub-dpo");
  staff = await createActor("tpub-staff");
  tenantId = await createTenant(dpo, "Training Publishing Co", "voluntary");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

describe("the product rules, as constraints", () => {
  it("defaults the pass mark to 90 and refuses anything easier", async () => {
    const { data } = await newModule();
    const { data: row } = await adminClient()
      .from("training_module")
      .select("pass_mark")
      .eq("id", data!.id)
      .single();
    expect(row!.pass_mark).toBe(90);

    const { error } = await newModule({ pass_mark: 70 });
    expect(error?.message).toContain("pass_mark_is_demanding");
  });

  // A module that runs long is one people click through.
  it("refuses a module longer than ten minutes", async () => {
    const { error } = await newModule({ estimated_minutes: 25 });
    expect(error?.message).toContain("fits_in_a_break");
  });
});

describe("publishing", () => {
  it("records who stood behind it", async () => {
    const { data: module } = await newModule();
    await addQuestion(module!.id);

    const { error } = await dpo.client.rpc("publish_training_module", {
      p_caller_person_id: dpo.personId,
      p_module_id: module!.id,
    });
    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("training_module")
      .select("published, reviewed_by")
      .eq("id", module!.id)
      .single();
    expect(data).toEqual({ published: true, reviewed_by: dpo.personId });
  });

  // A generated question with no key is marked wrong for everyone who takes it,
  // and one missing key in a batch is invisible on screen.
  it("refuses to publish while any question has no answer", async () => {
    const { data: module } = await newModule();
    await addQuestion(module!.id, 1, true);
    await addQuestion(module!.id, 2, false);

    const { error } = await dpo.client.rpc("publish_training_module", {
      p_caller_person_id: dpo.personId,
      p_module_id: module!.id,
    });
    expect(error?.message).toContain("every question needs an answer");
  });

  it("refuses to publish a module with no questions at all", async () => {
    const { data: module } = await newModule();
    const { error } = await dpo.client.rpc("publish_training_module", {
      p_caller_person_id: dpo.personId,
      p_module_id: module!.id,
    });
    expect(error?.message).toContain("no questions");
  });

  // CLAUDE.md: AI output never reaches a canonical record without a human.
  // Published training is the sharpest case — wrong content teaches thirty
  // people the wrong thing and produces a record saying they were trained.
  it("cannot mark generated content published without a reviewer", async () => {
    const { data: module } = await newModule({ source: "ai_generated" });
    const { error } = await adminClient()
      .from("training_module")
      .update({ published: true })
      .eq("id", module!.id);
    expect(error?.message).toContain("generated_training_is_reviewed_before_publishing");
  });

  it("refuses a staff member publishing, as not found", async () => {
    const { data: module } = await newModule();
    await addQuestion(module!.id);
    const { error } = await staff.client.rpc("publish_training_module", {
      p_caller_person_id: staff.personId,
      p_module_id: module!.id,
    });
    expect(error?.message).toContain("not found");
  });
});

describe("sending it to everyone", () => {
  it("assigns every live member once, and is safe to press twice", async () => {
    const { data: module } = await newModule();
    await addQuestion(module!.id);
    await dpo.client.rpc("publish_training_module", {
      p_caller_person_id: dpo.personId,
      p_module_id: module!.id,
    });

    const first = await dpo.client.rpc("assign_training_to_everyone", {
      p_caller_person_id: dpo.personId,
      p_tenant_id: tenantId,
      p_module_id: module!.id,
    });
    // The DPO and the staff member.
    expect(first.data).toBe(2);

    // Pressing it again must not give people a second copy of the same task.
    const second = await dpo.client.rpc("assign_training_to_everyone", {
      p_caller_person_id: dpo.personId,
      p_tenant_id: tenantId,
      p_module_id: module!.id,
    });
    expect(second.data).toBe(0);

    const { data: assignments } = await adminClient()
      .from("assignment")
      .select("assignee_id")
      .eq("training_module_id", module!.id);
    expect(assignments).toHaveLength(2);
  });

  // Sending a draft to the whole company is the mistake worth preventing.
  it("refuses to send an unpublished module", async () => {
    const { data: module } = await newModule();
    const { error } = await dpo.client.rpc("assign_training_to_everyone", {
      p_caller_person_id: dpo.personId,
      p_tenant_id: tenantId,
      p_module_id: module!.id,
    });
    expect(error?.message).toContain("publish this module before sending");
  });

  it("refuses a staff member sending one, as not found", async () => {
    const { data: module } = await newModule();
    const { error } = await staff.client.rpc("assign_training_to_everyone", {
      p_caller_person_id: staff.personId,
      p_tenant_id: tenantId,
      p_module_id: module!.id,
    });
    expect(error?.message).toContain("not found");
  });
});
