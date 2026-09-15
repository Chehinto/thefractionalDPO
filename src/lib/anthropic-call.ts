import "server-only";

import { AiRuntimeError } from "./ai-suggestion-runtime";
import { supportsEffort } from "./ai-models";

/**
 * One Anthropic Messages call that returns JSON.
 *
 * Extracted from `ai-suggestion-runtime` when training generation became the
 * second caller — per this repo's rule, shared only once something else
 * actually needed it, not in advance.
 *
 * What lives here is the part that is the same whatever is being asked for: the
 * transport, the timeout, the effort hint, and reading text blocks out of a
 * reply. What stays with each caller is the part that differs — the prompt, the
 * shape expected back, and what counts as an acceptable answer.
 */

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 30_000;

export interface AnthropicJsonResult {
  parsed: unknown;
  usage: { inputTokens: number; outputTokens: number };
  /** A reply stopped at the ceiling is incomplete JSON by definition. */
  truncated: boolean;
}

export async function callAnthropicJson({
  system,
  user,
  model,
  apiKey,
  maxTokens,
}: {
  system: string;
  user: string;
  model: string;
  apiKey: string;
  maxTokens: number;
}): Promise<AnthropicJsonResult> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // No browser-access header: this module is `server-only`, so the key
        // never leaves the server and the call is never made from a page.
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // Structured output, not open-ended reasoning. Sent only where the
        // model accepts it — Haiku rejects the parameter outright.
        ...(supportsEffort(model) ? { output_config: { effort: "low" } } : {}),
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new AiRuntimeError(
      timedOut ? 504 : 502,
      timedOut
        ? "The AI provider did not respond in time"
        : "The AI provider could not be reached"
    );
  }

  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new AiRuntimeError(502, "The AI provider could not answer");
  }

  return {
    parsed: parseJsonFromTextBlocks(json),
    usage: readUsage(json),
    truncated: isRecord(json) && json.stop_reason === "max_tokens",
  };
}

/**
 * Pull the JSON object out of a Messages reply.
 *
 * Tolerates a code fence: without a schema-enforcing API the model sometimes
 * wraps the object despite being told not to, and that is correct output in the
 * wrong envelope rather than a reason to spend a retry.
 */
export function parseJsonFromTextBlocks(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    throw new AiRuntimeError(502, "The AI provider returned no structured answer");
  }

  const text = raw.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();

  if (!text) throw new AiRuntimeError(502, "The AI provider returned no structured answer");

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  try {
    return JSON.parse((fenced ? fenced[1]! : text).trim());
  } catch {
    throw new AiRuntimeError(502, "The AI provider returned malformed JSON");
  }
}

function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  if (!isRecord(raw) || !isRecord(raw.usage)) return { inputTokens: 0, outputTokens: 0 };
  const n = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  return { inputTokens: n(raw.usage.input_tokens), outputTokens: n(raw.usage.output_tokens) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
