/**
 * Drafting a training module.
 *
 * The 90% pass mark drives most of what follows. At 90%, one wrong answer in
 * four is a retake — so a malformed or ambiguous question is not a cosmetic
 * problem, it sends people back to the start having learned nothing.
 */

import { describe, expect, it } from "vitest";
import {
  buildTrainingPrompt,
  estimateMinutes,
  parseGeneratedTraining,
} from "@/lib/generate-training";

const GOOD_QUESTION = {
  question: "You have just emailed the wrong attachment to a client. What first?",
  options: ["Recall it and say nothing", "Tell the DPO straight away", "Wait and see"],
  correctIndex: 1,
  explanation: "The 72-hour clock starts when someone becomes aware, so telling them starts it.",
};

const GOOD = {
  title: "Handling personal data on email",
  body: "Check the recipient before attaching anything with names in it.",
  estimatedMinutes: 6,
  questions: [GOOD_QUESTION, GOOD_QUESTION, GOOD_QUESTION, GOOD_QUESTION],
};

describe("the prompt", () => {
  it("asks for scenarios rather than definitions", () => {
    const { system } = buildTrainingPrompt({ topic: "Email", context: null, minutes: 8 });
    expect(system).toContain("scenarios, not definitions");
    expect(system).toContain("4pm on a Friday");
  });

  // Ten minutes is a schema constraint, so a longer draft cannot be saved.
  it("never asks for more than ten minutes, whatever it is given", () => {
    const { system } = buildTrainingPrompt({ topic: "Email", context: null, minutes: 45 });
    expect(system).toContain("in 10 minutes");
    expect(system).not.toContain("45");
  });

  it("tells the model the pass mark, and what that means for fairness", () => {
    const { system } = buildTrainingPrompt({ topic: "Email", context: null, minutes: 5 });
    expect(system).toContain("pass mark is 90%");
    expect(system).toContain("No trick wording");
  });

  it("writes for someone who is not a specialist", () => {
    const { system } = buildTrainingPrompt({ topic: "Email", context: null, minutes: 5 });
    expect(system).toContain("did not ask to do this");
    expect(system).toContain("No article numbers");
  });

  it("passes the company's own context through, so examples are not generic", () => {
    const { user } = buildTrainingPrompt({
      topic: "Email",
      context: "A recruitment agency placing contractors in regulated roles.",
      minutes: 5,
    });
    expect(user).toContain("recruitment agency");
  });
});

describe("parsing a draft", () => {
  it("keeps a well-formed module", () => {
    const draft = parseGeneratedTraining(GOOD, "claude-haiku-4-5");
    expect(draft.title).toBe("Handling personal data on email");
    expect(draft.questions).toHaveLength(4);
    expect(draft.promptKey).toBe("training_module_v1");
  });

  it("caps the estimate at ten minutes even when the model says otherwise", () => {
    expect(parseGeneratedTraining({ ...GOOD, estimatedMinutes: 30 }, "m").estimatedMinutes).toBe(10);
  });

  // At 90%, three questions gives 67% or 100% and nothing between — one slip is
  // a retake with no partial signal. Better to refuse than to publish that.
  it("refuses a draft with too few questions for a 90% pass mark", () => {
    expect(() =>
      parseGeneratedTraining({ ...GOOD, questions: [GOOD_QUESTION, GOOD_QUESTION] }, "m")
    ).toThrow("too few usable questions");
  });

  it("refuses a draft with no title or no body", () => {
    expect(() => parseGeneratedTraining({ ...GOOD, title: "  " }, "m")).toThrow("without a title");
    expect(() => parseGeneratedTraining({ ...GOOD, body: "" }, "m")).toThrow("any content");
  });
});

describe("questions that are dropped rather than repaired", () => {
  // Repairing is a guess about what the model meant, and a wrong guess marks a
  // correct answer wrong for everyone who takes the module.
  const bad = (override: Record<string, unknown>) =>
    parseGeneratedTraining(
      { ...GOOD, questions: [GOOD_QUESTION, GOOD_QUESTION, GOOD_QUESTION, { ...GOOD_QUESTION, ...override }] },
      "m"
    );

  it("drops one whose answer points outside its options", () => {
    expect(() => bad({ correctIndex: 7 })).toThrow("too few usable questions");
    expect(() => bad({ correctIndex: -1 })).toThrow("too few usable questions");
  });

  // Two identical options means one of them is also silently correct.
  it("drops one with duplicate options", () => {
    expect(() => bad({ options: ["Tell the DPO", "Tell the DPO", "Wait"] })).toThrow(
      "too few usable questions"
    );
  });

  it("drops one with a single option, or none", () => {
    expect(() => bad({ options: ["Only answer"] })).toThrow("too few usable questions");
  });

  // A quiz that says "wrong" and stops teaches only that you were wrong.
  it("drops one with no explanation", () => {
    expect(() => bad({ explanation: "" })).toThrow("too few usable questions");
  });
});

describe("estimating length from the body", () => {
  it("scales with the reading and stays inside the cap", () => {
    expect(estimateMinutes("a few short words")).toBeLessThanOrEqual(2);
    expect(estimateMinutes("word ".repeat(5000))).toBe(10);
  });
});
