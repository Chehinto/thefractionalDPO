import "server-only";

import {
  type AiProvider,
  type AiTask,
  type AiTier,
  modelFor,
  supportsEffort,
  tierFor,
} from "./ai-models";

export type Confidence = "stated" | "inferred" | "unknown";

export const AI_SUGGESTION_KINDS = [
  "register_intake",
  "register_reconciliation",
  "dpia_risk_summary",
  "dpia_mitigation",
  "vendor_first_view",
  "vendor_questionnaire_follow_up",
  "vendor_response_reconciliation",
  "privacy_notice_section",
  "cookie_notice_section",
  "retention_policy_section",
  "governance_next_action",
] as const;

export type AiSuggestionKind = (typeof AI_SUGGESTION_KINDS)[number];

export interface AiSuggestionRequest {
  kind: AiSuggestionKind;
  sourceText: string;
  sourceLabel: string | null;
  instruction: string | null;
  titleHint: string | null;
  processingActivityId: string | null;
  dpiaId: string | null;
  vendorDocumentId: string | null;
  vendorQuestionnaireId: string | null;
  vendorQuestionnaireResponseId: string | null;
  vendorRequestId: string | null;
  softwareDiscoverySignalId: string | null;
  generatedDocumentDraftId: string | null;
}

/**
 * One provider call. Kept individually rather than summed because an escalation
 * that is only recorded as its successful retry hides what the cheap attempt
 * cost — and how often the fast tier fails is the only real evidence for
 * whether `AI_TASK_TIERS` is set right.
 */
export interface AiAttempt {
  model: string;
  tier: AiTier;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  reason?: string;
}

export interface AiSuggestionDraft {
  title: string;
  responseText: string;
  sourceExcerpt: string;
  sourceLabel: string | null;
  confidence: Confidence;
  confidenceScore: number;
  model: string;
  tier: AiTier;
  promptKey: string;
  /** Summed across attempts, so an escalated draft reports what it truly cost. */
  inputTokens: number;
  outputTokens: number;
  escalated: boolean;
  attempts: AiAttempt[];
  usedFallback: boolean;
}

export class AiRuntimeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AiRuntimeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SOURCE_CHARS = 30_000;
const PROMPT_KEY = "ai_suggestion_review_v1";

/**
 * A provider that accepts the connection and then stalls would otherwise hold
 * the route open until the platform kills it, with no error anyone can act on.
 * Software discovery makes one call per signal, so an unbounded call there
 * stalls a whole import rather than a single request.
 */
const AI_REQUEST_TIMEOUT_MS = 30_000;

const TASK: AiTask = "ai_suggestion_generation";
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * The response shape, stated in the prompt rather than enforced by the API.
 * Anthropic's Messages API has no strict JSON-schema mode, so the guarantee
 * comes from `validateAiSuggestionOutput` instead — which is where it belonged
 * anyway: the schema could constrain the shape of `sourceExcerpt` but never
 * whether the excerpt actually appears in the source.
 */
const OUTPUT_CONTRACT =
  'Reply with only a JSON object, no prose and no code fence, with exactly these keys: ' +
  '"title" (string), "responseText" (string), "sourceExcerpt" (string copied verbatim from the source text), ' +
  '"confidence" (one of "stated", "inferred", "unknown"), and "confidenceScore" (integer 1-100).';

export function parseAiSuggestionRequest(raw: unknown): AiSuggestionRequest {
  const body = isRecord(raw) ? raw : {};
  const kind = body.kind;
  const sourceText = textField(body.sourceText).slice(0, MAX_SOURCE_CHARS);

  if (!AI_SUGGESTION_KINDS.includes(kind as AiSuggestionKind)) {
    throw new AiRuntimeError(400, "Unknown AI suggestion kind");
  }
  if (!sourceText) {
    throw new AiRuntimeError(400, "Source text is required");
  }

  return {
    kind: kind as AiSuggestionKind,
    sourceText,
    sourceLabel: optionalText(body.sourceLabel),
    instruction: optionalText(body.instruction),
    titleHint: optionalText(body.titleHint),
    processingActivityId: optionalUuid(body.processingActivityId, "processingActivityId"),
    dpiaId: optionalUuid(body.dpiaId, "dpiaId"),
    vendorDocumentId: optionalUuid(body.vendorDocumentId, "vendorDocumentId"),
    vendorQuestionnaireId: optionalUuid(body.vendorQuestionnaireId, "vendorQuestionnaireId"),
    vendorQuestionnaireResponseId: optionalUuid(
      body.vendorQuestionnaireResponseId,
      "vendorQuestionnaireResponseId"
    ),
    vendorRequestId: optionalUuid(body.vendorRequestId, "vendorRequestId"),
    softwareDiscoverySignalId: optionalUuid(
      body.softwareDiscoverySignalId,
      "softwareDiscoverySignalId"
    ),
    generatedDocumentDraftId: optionalUuid(body.generatedDocumentDraftId, "generatedDocumentDraftId"),
  };
}

/**
 * Draft one suggestion, on the platform's own key.
 *
 * This is the pay-as-you-go path and the only one: unlike AxioVendo, this
 * product has no plan where a customer brings their own provider, so there is
 * no browser-side caller and no second key to resolve. The tier/escalation
 * shape is AxioVendo's, because the reason for it carries over — a fast-tier
 * result that fails validation is worth one retry on the capable model, and
 * both attempts are worth recording.
 */
export async function generateAiSuggestionDraft(
  request: AiSuggestionRequest
): Promise<AiSuggestionDraft> {
  const apiKey = process.env.DPO_AI_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return unconfiguredDraft(request);

  const provider = (process.env.DPO_AI_PROVIDER || "anthropic") as AiProvider;
  const baseTier = tierFor(TASK);
  const attempts: AiAttempt[] = [];

  // Kept so that a failure on every tier reports the provider's actual problem
  // — a timeout stays a 504 rather than being flattened into a generic 502.
  let lastError: unknown = null;

  const attempt = async (tier: AiTier) => {
    const model = modelFor(provider, tier);
    try {
      const { parsed, usage, truncated } = await callProvider(request, provider, model, apiKey);
      // A reply cut off at the token ceiling is incomplete JSON by definition;
      // repairing the string cannot recover what was never sent.
      if (truncated) throw new AiRuntimeError(502, "The AI provider's reply was cut off");
      const draft = validateAiSuggestionOutput(request, parsed);
      attempts.push({ model, tier, ...usage, ok: true });
      return { draft, model, tier };
    } catch (e) {
      lastError = e;
      const reason = e instanceof Error ? e.message : String(e);
      attempts.push({ model, tier, inputTokens: 0, outputTokens: 0, ok: false, reason });
      return null;
    }
  };

  let accepted = await attempt(baseTier);

  // Only the cheap tier escalates. A capable-tier failure is a real failure;
  // retrying the same model on the same input would just spend twice.
  const escalated = accepted === null && baseTier === "fast";
  if (escalated) accepted = await attempt("capable");

  if (!accepted) {
    if (lastError instanceof AiRuntimeError) throw lastError;
    throw new AiRuntimeError(502, "The AI provider could not generate a suggestion");
  }

  return {
    ...accepted.draft,
    model: accepted.model,
    tier: accepted.tier,
    promptKey: PROMPT_KEY,
    inputTokens: attempts.reduce((total, a) => total + a.inputTokens, 0),
    outputTokens: attempts.reduce((total, a) => total + a.outputTokens, 0),
    escalated,
    attempts,
    usedFallback: false,
  };
}

async function callProvider(
  request: AiSuggestionRequest,
  provider: AiProvider,
  model: string,
  apiKey: string
): Promise<{
  parsed: unknown;
  usage: { inputTokens: number; outputTokens: number };
  truncated: boolean;
}> {
  if (provider !== "anthropic") {
    throw new AiRuntimeError(500, `Unsupported AI provider: ${provider}`);
  }

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // No browser-access header: this module is `server-only`, so the key
        // never leaves the server and the call is never made from a page.
      },
      body: JSON.stringify(buildAnthropicSuggestionPayload(request, model)),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
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
    throw new AiRuntimeError(502, "The AI provider could not generate a suggestion");
  }

  return {
    parsed: parseAnthropicSuggestionJson(json),
    usage: responseUsage(json),
    truncated: isRecord(json) && json.stop_reason === "max_tokens",
  };
}

export function buildAnthropicSuggestionPayload(request: AiSuggestionRequest, model: string) {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // Structured extraction, not open-ended reasoning: low effort keeps latency
    // and spend down without hurting quality. Sent only where the model accepts
    // it — Haiku rejects the parameter outright.
    ...(supportsEffort(model) ? { output_config: { effort: "low" } } : {}),
    system:
      "You draft GDPR compliance review suggestions for a DPO. " +
      "Never invent a source excerpt: sourceExcerpt must be copied exactly from the source text. " +
      OUTPUT_CONTRACT,
    messages: [
      {
        role: "user",
        content: [
          `Suggestion kind: ${request.kind}`,
          request.titleHint ? `Title hint: ${request.titleHint}` : null,
          request.instruction ? `Instruction: ${request.instruction}` : null,
          request.sourceLabel ? `Source label: ${request.sourceLabel}` : null,
          "Source text:",
          request.sourceText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  };
}

export function parseAnthropicSuggestionJson(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    throw new AiRuntimeError(502, "The AI provider returned no structured suggestion");
  }

  const text = raw.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();

  if (!text) throw new AiRuntimeError(502, "The AI provider returned no structured suggestion");
  return parseJson(text);
}

/** The parts of a draft that come from the model, before call metadata is attached. */
export type ValidatedAiSuggestion = Pick<
  AiSuggestionDraft,
  "title" | "responseText" | "sourceExcerpt" | "sourceLabel" | "confidence" | "confidenceScore"
>;

export function validateAiSuggestionOutput(
  request: AiSuggestionRequest,
  raw: unknown
): ValidatedAiSuggestion {
  if (!isRecord(raw)) throw new AiRuntimeError(502, "The AI provider returned invalid JSON");

  const title = textField(raw.title);
  const responseText = textField(raw.responseText);
  const sourceExcerpt = textField(raw.sourceExcerpt);
  const confidence = raw.confidence;
  const confidenceScore =
    typeof raw.confidenceScore === "number" && Number.isInteger(raw.confidenceScore)
      ? raw.confidenceScore
      : null;

  if (!title || !responseText || !sourceExcerpt) {
    throw new AiRuntimeError(502, "The AI provider returned an incomplete suggestion");
  }
  if (!["stated", "inferred", "unknown"].includes(confidence as string)) {
    throw new AiRuntimeError(502, "The AI provider returned an invalid confidence tag");
  }
  if (confidenceScore === null || confidenceScore < 1 || confidenceScore > 100) {
    throw new AiRuntimeError(502, "The AI provider returned an invalid confidence score");
  }
  if (!request.sourceText.includes(sourceExcerpt)) {
    throw new AiRuntimeError(502, "The AI provider cited text that was not in the source");
  }

  return {
    title,
    responseText,
    sourceExcerpt,
    sourceLabel: request.sourceLabel,
    confidence: confidence as Confidence,
    confidenceScore,
  };
}

/**
 * What happens with no key configured.
 *
 * In production this refuses, the way AxioVendo's PAYG route does: a workspace
 * silently filling its review queue with placeholder text that no model wrote
 * is worse than an error, because the placeholders are indistinguishable from
 * real drafts once a DPO is working through the queue.
 *
 * Outside production it returns a clearly-labelled local draft instead, so that
 * the intake and review flows can be developed and end-to-end tested without a
 * key and without spend. The draft still goes through the same validation, so
 * the fallback cannot produce something the real path would reject.
 */
function unconfiguredDraft(request: AiSuggestionRequest): AiSuggestionDraft {
  if (process.env.NODE_ENV === "production") {
    throw new AiRuntimeError(503, "AI is not configured on this deployment (set DPO_AI_KEY)");
  }

  const excerpt = firstUsefulExcerpt(request.sourceText);
  const title = request.titleHint || titleForKind(request.kind);
  const responseText =
    `${title}: review the cited source before applying this suggestion. ` +
    "The runtime used the local fallback because no AI provider key is configured.";
  const inputTokens = estimateTokens(request.sourceText);
  const outputTokens = estimateTokens(responseText);
  const model = "local-ai-suggestion-fallback";

  return {
    ...validateAiSuggestionOutput(request, {
      title,
      responseText,
      sourceExcerpt: excerpt,
      confidence: "inferred",
      confidenceScore: 55,
    }),
    model,
    tier: "fast",
    promptKey: PROMPT_KEY,
    inputTokens,
    outputTokens,
    escalated: false,
    attempts: [{ model, tier: "fast", inputTokens, outputTokens, ok: true }],
    usedFallback: true,
  };
}

function titleForKind(kind: AiSuggestionKind): string {
  const label = kind.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function firstUsefulExcerpt(sourceText: string): string {
  const sentence = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (sentence || sourceText.trim()).slice(0, 500);
}

function responseUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  if (!isRecord(raw) || !isRecord(raw.usage)) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: numberField(raw.usage.input_tokens),
    outputTokens: numberField(raw.usage.output_tokens),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Strip a code fence before parsing. Without a schema-enforcing API the model
 * sometimes wraps the object despite being told not to, and a fenced reply is
 * correct output in the wrong envelope — not a reason to spend a retry.
 */
function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  try {
    return JSON.parse((fenced ? fenced[1]! : text).trim());
  } catch {
    throw new AiRuntimeError(502, "The AI provider returned malformed JSON");
  }
}

function optionalUuid(value: unknown, field: string): string | null {
  const text = optionalText(value);
  if (text === null) return null;
  if (!UUID.test(text)) throw new AiRuntimeError(400, `${field} must be a UUID`);
  return text;
}

function optionalText(value: unknown): string | null {
  const text = textField(value);
  return text.length > 0 ? text : null;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
