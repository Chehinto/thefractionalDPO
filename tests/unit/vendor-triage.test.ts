/**
 * Triage: what a model may say about detected software, and what it may not.
 *
 * The rule the schema enforces and these tests pin: this is recollection, not
 * evidence. It can never be `stated`, it must be allowed to say "I don't know",
 * and a verdict without reasoning is dropped rather than shown.
 */

import { describe, expect, it } from "vitest";
import {
  buildTriagePrompt,
  parseTriageOutput,
  TRIAGE_VERDICT_LABELS,
  TRIAGE_VERDICT_MEANINGS,
} from "@/lib/vendor-triage";

const REQUEST = {
  softwareName: "Notion",
  vendorName: "Notion Labs",
  homepageUrl: "https://notion.so",
  sourceContext: "NOTION.SO monthly workspace subscription, Xero accounting payment",
};

describe("the prompt", () => {
  const { system, user } = buildTriagePrompt(REQUEST);

  // The whole design rests on not retrieving anything. If the URL ever reads
  // as something to open, the SSRF surface is back.
  it("passes the URL as context a human could check, not as something to read", () => {
    expect(user).toContain("not visited");
    expect(system).toContain("You are NOT reading its website");
  });

  it("tells the model that not knowing is an acceptable answer", () => {
    expect(system).toContain("say so");
    expect(system).toContain("A blank answer is useful");
  });

  // The model knows the product; it cannot know how this company uses it.
  it("asks about the product, not about this company's use of it", () => {
    expect(system).toContain("Judge the product, not the company");
    expect(system).toContain("you cannot know that");
  });

  it("does not offer `stated` as a confidence the model may return", () => {
    expect(system).toContain('"inferred" or "unknown"');
    expect(system).not.toContain('"stated"');
  });
});

describe("parsing what comes back", () => {
  it("keeps a complete, reasoned verdict", () => {
    const draft = parseTriageOutput(
      {
        whatItDoes: "A workspace tool for notes, documents and databases.",
        whatItProcesses: "Whatever staff put in it, plus account and usage data.",
        verdict: "dpia_recommended",
        verdictRationale: "Staff routinely paste personal data into shared notes.",
        confidence: "inferred",
        confidenceScore: 70,
      },
      "claude-haiku-4-5"
    );

    expect(draft).toMatchObject({
      verdict: "dpia_recommended",
      confidence: "inferred",
      confidenceScore: 70,
    });
  });

  // The schema refuses `stated` on this table. The parser must never produce it
  // either, whatever the model claims.
  it("never returns `stated`, even when the model asks for it", () => {
    const draft = parseTriageOutput({ confidence: "stated", whatItDoes: "x" }, "m");
    expect(draft.confidence).toBe("unknown");
  });

  // A bare label is something a DPO would have to trust blind.
  it("drops a verdict that arrives without reasoning, keeping the summary", () => {
    const draft = parseTriageOutput(
      {
        whatItDoes: "A workspace tool.",
        verdict: "high_risk_mitigation_required",
        verdictRationale: "   ",
        confidence: "inferred",
        confidenceScore: 90,
      },
      "m"
    );

    expect(draft.verdict).toBeNull();
    expect(draft.confidenceScore).toBe(0);
    expect(draft.whatItDoes).toBe("A workspace tool.");
  });

  it("drops a verdict that arrives with no real score", () => {
    const draft = parseTriageOutput(
      { verdict: "no_risk_identified", verdictRationale: "Nothing notable.", confidenceScore: 0 },
      "m"
    );
    expect(draft.verdict).toBeNull();
  });

  it("rejects a verdict that is not one of the three", () => {
    const draft = parseTriageOutput(
      { verdict: "definitely_fine", verdictRationale: "Trust me.", confidenceScore: 99 },
      "m"
    );
    expect(draft.verdict).toBeNull();
  });

  // Models write "unknown" as prose when asked for null more often than not.
  it("reads a prose non-answer as no answer", () => {
    for (const text of ["unknown", "Unknown.", "N/A", "I don't know"]) {
      expect(parseTriageOutput({ whatItDoes: text }, "m").whatItDoes).toBeNull();
    }
  });

  it("survives a reply that is not an object", () => {
    expect(() => parseTriageOutput("nope", "m")).toThrow("invalid JSON");
  });
});

describe("what the verdicts say on screen", () => {
  // "No risk identified" is a claim about our looking, not about the world.
  it("does not claim there is no risk", () => {
    expect(TRIAGE_VERDICT_LABELS.no_risk_identified).toBe("No risk identified");
    expect(TRIAGE_VERDICT_MEANINGS.no_risk_identified).toContain("not the same as there being none");
  });

  // Art. 36 turns on residual risk, which does not exist before mitigations.
  it("says ICO consultation is possible, never required", () => {
    const meaning = TRIAGE_VERDICT_MEANINGS.high_risk_mitigation_required;
    expect(TRIAGE_VERDICT_LABELS.high_risk_mitigation_required).toContain("mitigation required");
    expect(meaning).toContain("possible ICO consultation");
    expect(meaning).toContain("AFTER mitigations");
  });
});
