/**
 * Training, and the one thing that makes a quiz mean anything.
 *
 * A staff member and an Active DPO are the same Postgres role, so column
 * grants cannot hide the answer key from a trainee. These tests pin the
 * row-level solution: the key is a separate, DPO-only table, and grading
 * happens in a definer function that is the only thing reading both sides.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let staff: Actor;
let outsider: Actor;
let tenantId: string;
let moduleId: string;

async function seedModule(published = true) {
  const { data: module, error } = await dpo.client
    .from("training_module")
    .insert({
      tenant_id: tenantId,
      title: "Handling personal data on email",
      body: "Check the recipient before attaching anything with names in it.",
      created_by: dpo.personId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const { data: questions } = await dpo.client
    .from("training_question")
    .insert([
      {
        tenant_id: tenantId,
        module_id: module!.id,
        position: 1,
        question: "You are about to email a spreadsheet of customers. What first?",
        options: ["Send it", "Check the recipient and whether they need all of it", "CC everyone"],
      },
      {
        tenant_id: tenantId,
        module_id: module!.id,
        position: 2,
        question: "You sent it to the wrong person. What now?",
        options: ["Say nothing", "Tell the DPO straight away", "Recall it and move on"],
      },
    ])
    .select("id, position");

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

beforeAll(async () => {
  dpo = await createActor("training-dpo");
  staff = await createActor("training-staff");
  outsider = await createActor("training-outsider");
  tenantId = await createTenant(dpo, "Training Co", "voluntary");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
  moduleId = await seedModule();
});

describe("the answer key", () => {
  // The whole reason the key is a separate table.
  it("is invisible to the person taking the quiz", async () => {
    const { data } = await staff.client.from("training_answer_key").select("correct_index");
    expect(data).toEqual([]);
  });

  it("is visible to the DPO who wrote it", async () => {
    const { data } = await dpo.client
      .from("training_answer_key")
      .select("correct_index")
      .eq("tenant_id", tenantId);
    expect(data!.length).toBeGreaterThan(0);
  });

  it("does not stop the trainee reading the questions themselves", async () => {
    const { data } = await staff.client
      .from("training_question")
      .select("question, options")
      .eq("module_id", moduleId);
    expect(data).toHaveLength(2);
    expect((data![0] as { options: string[] }).options.length).toBeGreaterThan(1);
  });
});

describe("taking a module", () => {
  it("grades it, records the attempt, and only then reveals the answers", async () => {
    const { data, error } = await staff.client.rpc("submit_training_attempt", {
      p_caller_person_id: staff.personId,
      p_module_id: moduleId,
      p_answers: [1, 1],
    });

    expect(error).toBeNull();
    const rows = data as { score: number; passed: boolean; was_correct: boolean; explanation: string }[];
    expect(rows[0]!.score).toBe(100);
    expect(rows[0]!.passed).toBe(true);
    expect(rows.every((r) => r.was_correct)).toBe(true);
    // Teaching, not just a verdict.
    expect(rows[0]!.explanation).toContain("72-hour clock");
  });

  it("fails an attempt below the pass mark, and says which were wrong", async () => {
    const { data } = await staff.client.rpc("submit_training_attempt", {
      p_caller_person_id: staff.personId,
      p_module_id: moduleId,
      p_answers: [0, 1],
    });
    const rows = data as { score: number; passed: boolean; was_correct: boolean }[];
    expect(rows[0]!.score).toBe(50);
    expect(rows[0]!.passed).toBe(false);
    expect(rows.map((r) => r.was_correct)).toEqual([false, true]);
  });

  it("refuses a partial submission", async () => {
    const { error } = await staff.client.rpc("submit_training_attempt", {
      p_caller_person_id: staff.personId,
      p_module_id: moduleId,
      p_answers: [1],
    });
    expect(error?.message).toContain("answer every question");
  });

  it("refuses someone who is not a member, as not found", async () => {
    const { error } = await outsider.client.rpc("submit_training_attempt", {
      p_caller_person_id: outsider.personId,
      p_module_id: moduleId,
      p_answers: [1, 1],
    });
    expect(error?.message).toContain("not found");
  });

  it("refuses a module that is still a draft", async () => {
    const draftId = await seedModule(false);
    const { error } = await staff.client.rpc("submit_training_attempt", {
      p_caller_person_id: staff.personId,
      p_module_id: draftId,
      p_answers: [1, 1],
    });
    expect(error?.message).toContain("not found");

    // And the draft is not even listed for them.
    const { data } = await staff.client.from("training_module").select("id").eq("id", draftId);
    expect(data).toEqual([]);
  });
});

describe("the record of who was trained", () => {
  it("cannot be written directly — a client would be writing its own certificate", async () => {
    const { error } = await staff.client.from("training_attempt").insert({
      tenant_id: tenantId,
      module_id: moduleId,
      person_id: staff.personId,
      answers: [1, 1],
      score: 100,
      passed: true,
    });
    expect(error).not.toBeNull();
  });

  it("shows a staff member their own attempts and nobody else's", async () => {
    const other = await createActor("training-other-staff");
    await dpo.client.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: other.email,
      p_tier: "staff",
    });
    await other.client.rpc("submit_training_attempt", {
      p_caller_person_id: other.personId,
      p_module_id: moduleId,
      p_answers: [0, 0],
    });

    const { data: mine } = await staff.client
      .from("training_attempt")
      .select("person_id")
      .eq("tenant_id", tenantId);
    expect(mine!.every((row) => row.person_id === staff.personId)).toBe(true);

    // The DPO sees everyone's — that is the attendance record.
    const { data: all } = await adminClient()
      .from("training_attempt")
      .select("person_id")
      .eq("tenant_id", tenantId);
    expect(new Set(all!.map((r) => r.person_id)).size).toBeGreaterThan(1);
  });
});
