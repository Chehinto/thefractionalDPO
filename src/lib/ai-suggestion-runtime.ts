import "server-only";

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

export interface AiSuggestionDraft {
  title: string;
  responseText: string;
  sourceExcerpt: string;
  sourceLabel: string | null;
  confidence: Confidence;
  confidenceScore: number;
  model: string;
  promptKey: string;
  inputTokens: number;
  outputTokens: number;
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

export async function generateAiSuggestionDraft(
  request: AiSuggestionRequest
): Promise<AiSuggestionDraft> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return localSuggestionDraft(request);

  const model = process.env.OPENAI_AI_SUGGESTION_MODEL || "gpt-5-mini";
  const payload = buildOpenAiSuggestionPayload(request, model);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
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

  const parsed = parseOpenAiSuggestionJson(json);
  const usage = responseUsage(json);
  return {
    ...validateAiSuggestionOutput(request, parsed),
    model,
    promptKey: PROMPT_KEY,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usedFallback: false,
  };
}

export function buildOpenAiSuggestionPayload(request: AiSuggestionRequest, model: string) {
  return {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You draft GDPR compliance review suggestions for a DPO. " +
              "Return only the requested JSON. Never invent a source excerpt: sourceExcerpt must be copied exactly from the source text.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
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
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "fractional_dpo_ai_suggestion",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "responseText", "sourceExcerpt", "confidence", "confidenceScore"],
          properties: {
            title: { type: "string", minLength: 1 },
            responseText: { type: "string", minLength: 1 },
            sourceExcerpt: { type: "string", minLength: 1 },
            confidence: { type: "string", enum: ["stated", "inferred", "unknown"] },
            confidenceScore: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
  };
}

export function parseOpenAiSuggestionJson(raw: unknown): unknown {
  const outputText = isRecord(raw) && typeof raw.output_text === "string" ? raw.output_text : null;
  if (outputText) return parseJson(outputText);

  if (isRecord(raw) && Array.isArray(raw.output)) {
    for (const item of raw.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === "string") {
          return parseJson(content.text);
        }
      }
    }
  }

  throw new AiRuntimeError(502, "The AI provider returned no structured suggestion");
}

export function validateAiSuggestionOutput(
  request: AiSuggestionRequest,
  raw: unknown
): Omit<AiSuggestionDraft, "model" | "promptKey" | "inputTokens" | "outputTokens" | "usedFallback"> {
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

function localSuggestionDraft(request: AiSuggestionRequest): AiSuggestionDraft {
  const excerpt = firstUsefulExcerpt(request.sourceText);
  const title = request.titleHint || titleForKind(request.kind);
  const responseText =
    `${title}: review the cited source before applying this suggestion. ` +
    "The runtime used the local fallback because no OpenAI API key is configured.";

  return {
    ...validateAiSuggestionOutput(request, {
      title,
      responseText,
      sourceExcerpt: excerpt,
      confidence: "inferred",
      confidenceScore: 55,
    }),
    model: "local-ai-suggestion-fallback",
    promptKey: PROMPT_KEY,
    inputTokens: estimateTokens(request.sourceText),
    outputTokens: estimateTokens(responseText),
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
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
