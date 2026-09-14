/**
 * AI suggestion runtime rules.
 *
 * These tests stay pure on purpose. Provider calls, JSON parsing and evidence
 * validation are ordinary business logic; they do not need a browser, and they
 * should fail fast before a route ever tries to persist unreviewable AI output.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiRuntimeError,
  buildOpenAiSuggestionPayload,
  generateAiSuggestionDraft,
  parseAiSuggestionRequest,
  parseOpenAiSuggestionJson,
  validateAiSuggestionOutput,
} from "@/lib/ai-suggestion-runtime";

const SOURCE =
  "The company uses ScreenCo to run criminal record checks for regulated roles. " +
  "ScreenCo retains the data for 30 days after completion.";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("request parsing", () => {
  it("accepts known suggestion kinds and trims source text", () => {
    const parsed = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: `  ${SOURCE}  `,
      sourceLabel: "ScreenCo policy",
    });

    expect(parsed).toMatchObject({
      kind: "vendor_first_view",
      sourceText: SOURCE,
      sourceLabel: "ScreenCo policy",
    });
  });

  it("rejects unknown kinds and malformed linked ids", () => {
    expect(() =>
      parseAiSuggestionRequest({ kind: "anything", sourceText: SOURCE })
    ).toThrow(AiRuntimeError);

    expect(() =>
      parseAiSuggestionRequest({
        kind: "dpia_mitigation",
        sourceText: SOURCE,
        processingActivityId: "not-a-uuid",
      })
    ).toThrow("processingActivityId must be a UUID");
  });

  it("does not accept an empty source", () => {
    expect(() =>
      parseAiSuggestionRequest({ kind: "dpia_mitigation", sourceText: "   " })
    ).toThrow("Source text is required");
  });
});

describe("output validation", () => {
  const request = parseAiSuggestionRequest({
    kind: "dpia_mitigation",
    sourceText: SOURCE,
  });

  it("requires the cited excerpt to be copied from the source text", () => {
    expect(() =>
      validateAiSuggestionOutput(request, {
        title: "Retention mitigation",
        responseText: "Ask ScreenCo to document deletion controls.",
        sourceExcerpt: "This text is not in the source.",
        confidence: "inferred",
        confidenceScore: 80,
      })
    ).toThrow("cited text");
  });

  it("requires a positive numeric confidence score", () => {
    expect(() =>
      validateAiSuggestionOutput(request, {
        title: "Retention mitigation",
        responseText: "Ask ScreenCo to document deletion controls.",
        sourceExcerpt: "ScreenCo retains the data for 30 days after completion.",
        confidence: "inferred",
        confidenceScore: 0,
      })
    ).toThrow("confidence score");
  });
});

describe("provider payloads", () => {
  it("asks for strict structured JSON from the Responses API", () => {
    const request = parseAiSuggestionRequest({
      kind: "privacy_notice_section",
      sourceText: SOURCE,
      instruction: "Draft a candidate-facing notice clause.",
    });
    const payload = buildOpenAiSuggestionPayload(request, "gpt-test");

    expect(payload.model).toBe("gpt-test");
    expect(payload.text.format).toMatchObject({
      type: "json_schema",
      name: "fractional_dpo_ai_suggestion",
      strict: true,
    });
    expect(payload.text.format.schema.required).toEqual([
      "title",
      "responseText",
      "sourceExcerpt",
      "confidence",
      "confidenceScore",
    ]);
  });

  it("parses output_text JSON from an OpenAI response", () => {
    const parsed = parseOpenAiSuggestionJson({
      output_text: JSON.stringify({
        title: "Retention",
        responseText: "Review the retention period.",
        sourceExcerpt: "ScreenCo retains the data for 30 days after completion.",
        confidence: "stated",
        confidenceScore: 91,
      }),
    });

    expect(parsed).toMatchObject({ title: "Retention", confidenceScore: 91 });
  });
});

describe("generation", () => {
  it("uses a local review-safe fallback when no provider key is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const request = parseAiSuggestionRequest({
      kind: "governance_next_action",
      sourceText: SOURCE,
    });

    const draft = await generateAiSuggestionDraft(request);

    expect(draft.usedFallback).toBe(true);
    expect(draft.model).toBe("local-ai-suggestion-fallback");
    expect(SOURCE).toContain(draft.sourceExcerpt);
    expect(draft.confidence).toBe("inferred");
    expect(draft.confidenceScore).toBe(55);
  });

  it("validates provider output before returning it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_AI_SUGGESTION_MODEL", "gpt-test");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          title: "Vendor first view",
          responseText: "The vendor appears to process criminal record checks.",
          sourceExcerpt: "criminal record checks for regulated roles",
          confidence: "stated",
          confidenceScore: 93,
        }),
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
    } as Response);

    const request = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: SOURCE,
    });
    const draft = await generateAiSuggestionDraft(request);

    expect(draft).toMatchObject({
      usedFallback: false,
      model: "gpt-test",
      confidenceScore: 93,
      inputTokens: 20,
      outputTokens: 10,
    });
  });
});

describe("provider transport failures", () => {
  // A provider that accepts the connection and then stalls used to hold the
  // route open until the platform killed it. Software discovery makes one call
  // per signal, so a single stalled call there blocks a whole import.
  it("reports a stalled provider as a gateway timeout, not a hung request", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    const request = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: SOURCE,
    });

    await expect(generateAiSuggestionDraft(request)).rejects.toMatchObject({
      status: 504,
      message: "The AI provider did not respond in time",
    });
  });

  it("distinguishes an unreachable provider from a slow one", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const request = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: SOURCE,
    });

    await expect(generateAiSuggestionDraft(request)).rejects.toMatchObject({
      status: 502,
      message: "The AI provider could not be reached",
    });
  });

  it("sends an abort signal so the timeout is enforced by the request itself", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);

    const request = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: SOURCE,
    });
    await expect(generateAiSuggestionDraft(request)).rejects.toThrow(AiRuntimeError);

    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
