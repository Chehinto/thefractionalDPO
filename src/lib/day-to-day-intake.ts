import {
  type AiSuggestionRequest,
  AiRuntimeError,
} from "./ai-suggestion-runtime";

const MAX_NOTE_CHARS = 12_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DayToDayIntakeRequest {
  note: string;
  sourceLabel: string;
  processingActivityId: string | null;
}

export function parseDayToDayIntakeRequest(raw: unknown): DayToDayIntakeRequest {
  const body = isRecord(raw) ? raw : {};
  const note = textField(body.note).slice(0, MAX_NOTE_CHARS);
  if (!note) throw new AiRuntimeError(400, "Tell us what changed");

  return {
    note,
    sourceLabel: optionalText(body.sourceLabel) ?? "Day-to-day intake note",
    processingActivityId: optionalUuid(body.processingActivityId, "processingActivityId"),
  };
}

export function buildDayToDayIntakeSuggestionRequest(
  intake: DayToDayIntakeRequest
): AiSuggestionRequest {
  return {
    kind: "register_intake",
    sourceText: intake.note,
    sourceLabel: intake.sourceLabel,
    titleHint: "Register intake draft",
    instruction:
      "Turn this plain-English operational change into a DPO review note. " +
      "Identify likely Art. 30 register fields, vendor/purpose/role/data/subjects/retention gaps, " +
      "and any DPIA risk signals. Do not write final register text as fact unless the source states it.",
    processingActivityId: intake.processingActivityId,
    dpiaId: null,
    vendorDocumentId: null,
    vendorQuestionnaireId: null,
    vendorQuestionnaireResponseId: null,
    vendorRequestId: null,
    softwareDiscoverySignalId: null,
    generatedDocumentDraftId: null,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
