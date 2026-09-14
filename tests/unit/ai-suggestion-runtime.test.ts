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
  buildAnthropicSuggestionPayload,
  generateAiSuggestionDraft,
  parseAiSuggestionRequest,
  parseAnthropicSuggestionJson,
  validateAiSuggestionOutput,
} from "@/lib/ai-suggestion-runtime";

const SOURCE =
  "The company uses ScreenCo to run criminal record checks for regulated roles. " +
  "ScreenCo retains the data for 30 days after completion.";

const GOOD_OUTPUT = {
  title: "Vendor first view",
  responseText: "The vendor appears to process criminal record checks.",
  sourceExcerpt: "criminal record checks for regulated roles",
  confidence: "stated",
  confidenceScore: 93,
};

function anthropicReply(
  output: Record<string, unknown>,
  opts: { stopReason?: string } = {}
): Response {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: opts.stopReason ?? "end_turn",
      usage: { input_tokens: 20, output_tokens: 10 },
    }),
  } as Response;
}

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
  it("states the output contract in the system prompt, since the API cannot enforce a schema", () => {
    const request = parseAiSuggestionRequest({
      kind: "privacy_notice_section",
      sourceText: SOURCE,
      instruction: "Draft a candidate-facing notice clause.",
    });
    const payload = buildAnthropicSuggestionPayload(request, "claude-haiku-4-5");

    expect(payload.model).toBe("claude-haiku-4-5");
    expect(payload.max_tokens).toBeGreaterThan(0);
    expect(payload.system).toContain("sourceExcerpt must be copied exactly");
    for (const key of ["title", "responseText", "sourceExcerpt", "confidence", "confidenceScore"]) {
      expect(payload.system).toContain(key);
    }
    expect(payload.messages[0]!.content).toContain(SOURCE);
    expect(payload.messages[0]!.content).toContain("Draft a candidate-facing notice clause.");
  });

  // Haiku 4.5 rejects the effort parameter outright, so sending it
  // unconditionally would 400 every fast-tier call.
  it("sends the effort hint only to models that accept it", () => {
    const request = parseAiSuggestionRequest({
      kind: "privacy_notice_section",
      sourceText: SOURCE,
    });

    expect(buildAnthropicSuggestionPayload(request, "claude-haiku-4-5")).not.toHaveProperty(
      "output_config"
    );
    expect(buildAnthropicSuggestionPayload(request, "claude-sonnet-5")).toHaveProperty(
      "output_config"
    );
  });

  it("parses the text blocks of a Messages API reply", () => {
    const parsed = parseAnthropicSuggestionJson({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Retention",
            responseText: "Review the retention period.",
            sourceExcerpt: "ScreenCo retains the data for 30 days after completion.",
            confidence: "stated",
            confidenceScore: 91,
          }),
        },
      ],
    });

    expect(parsed).toMatchObject({ title: "Retention", confidenceScore: 91 });
  });

  it("tolerates a fenced reply rather than spending a retry on it", () => {
    const parsed = parseAnthropicSuggestionJson({
      content: [{ type: "text", text: '```json\n{"title":"Retention"}\n```' }],
    });

    expect(parsed).toMatchObject({ title: "Retention" });
  });
});

describe("generation", () => {
  it("uses a local review-safe fallback when no provider key is configured", async () => {
    vi.stubEnv("DPO_AI_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
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

  it("validates provider output before returning it, on the task's own tier", async () => {
    vi.stubEnv("DPO_AI_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(anthropicReply(GOOD_OUTPUT));

    const request = parseAiSuggestionRequest({
      kind: "vendor_first_view",
      sourceText: SOURCE,
    });
    const draft = await generateAiSuggestionDraft(request);

    expect(draft).toMatchObject({
      usedFallback: false,
      model: "claude-haiku-4-5",
      tier: "fast",
      escalated: false,
      confidenceScore: 93,
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(draft.attempts).toHaveLength(1);
  });

  it("calls the platform key, not a caller-supplied one", async () => {
    vi.stubEnv("DPO_AI_KEY", "platform-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(anthropicReply(GOOD_OUTPUT));

    await generateAiSuggestionDraft(
      parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
    );

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("platform-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // This module is server-only; the key must never be sent from a page.
    expect(headers).not.toHaveProperty("anthropic-dangerous-direct-browser-access");
  });

  it("falls back to ANTHROPIC_API_KEY when no DPO-specific key is set", async () => {
    vi.stubEnv("DPO_AI_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "shared-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(anthropicReply(GOOD_OUTPUT));

    await generateAiSuggestionDraft(
      parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
    );

    const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("shared-key");
  });
});

describe("an unconfigured deployment", () => {
  // A workspace quietly filling its review queue with placeholder text no model
  // wrote is worse than an error: once a DPO is working the queue, the
  // placeholders are indistinguishable from real drafts.
  it("refuses in production rather than emitting placeholder drafts", async () => {
    vi.stubEnv("DPO_AI_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      generateAiSuggestionDraft(
        parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
      )
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("tier escalation", () => {
  // The failure that matters is a citation the source does not contain. The
  // fast tier is only affordable because that failure buys a retry on the
  // capable model instead of being accepted into the review queue.
  it("escalates to the capable tier when the fast tier invents a citation", async () => {
    vi.stubEnv("DPO_AI_KEY", "test-key");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        anthropicReply({ ...GOOD_OUTPUT, sourceExcerpt: "a sentence that is not in the source" })
      )
      .mockResolvedValueOnce(anthropicReply(GOOD_OUTPUT));

    const draft = await generateAiSuggestionDraft(
      parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(draft).toMatchObject({ model: "claude-sonnet-5", tier: "capable", escalated: true });

    // Both attempts are recorded, so the wasted cheap call is visible as cost
    // rather than hidden behind the retry that worked.
    expect(draft.attempts).toHaveLength(2);
    expect(draft.attempts[0]).toMatchObject({ model: "claude-haiku-4-5", ok: false });
    expect(draft.attempts[1]).toMatchObject({ model: "claude-sonnet-5", ok: true });
    expect(draft.attempts[0]!.reason).toContain("cited text that was not in the source");
  });

  it("gives up rather than accepting a draft that fails on both tiers", async () => {
    vi.stubEnv("DPO_AI_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      anthropicReply({ ...GOOD_OUTPUT, sourceExcerpt: "invented" })
    );

    await expect(
      generateAiSuggestionDraft(
        parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
      )
    ).rejects.toThrow("cited text that was not in the source");
  });

  // A reply stopped at the ceiling is incomplete JSON by definition.
  it("treats a truncated reply as a failed attempt, not as output to repair", async () => {
    vi.stubEnv("DPO_AI_KEY", "test-key");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(anthropicReply(GOOD_OUTPUT, { stopReason: "max_tokens" }))
      .mockResolvedValueOnce(anthropicReply(GOOD_OUTPUT));

    const draft = await generateAiSuggestionDraft(
      parseAiSuggestionRequest({ kind: "vendor_first_view", sourceText: SOURCE })
    );

    expect(draft.escalated).toBe(true);
    expect(draft.attempts[0]!.reason).toContain("cut off");
  });
});

describe("provider transport failures", () => {
  // A provider that accepts the connection and then stalls used to hold the
  // route open until the platform killed it. Software discovery makes one call
  // per signal, so a single stalled call there blocks a whole import.
  it("reports a stalled provider as a gateway timeout, not a hung request", async () => {
    vi.stubEnv("DPO_AI_KEY", "test-key");
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
    vi.stubEnv("DPO_AI_KEY", "test-key");
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
    vi.stubEnv("DPO_AI_KEY", "test-key");
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
