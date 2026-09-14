import { type AiSuggestionRequest, AiRuntimeError } from "./ai-suggestion-runtime";

/**
 * Any live member can submit a vendor request — this is the only write path open
 * below the Active DPO tier — and the text it carries lands in a canonical row
 * and in a model prompt. The columns are unbounded `text` with only a non-empty
 * check, so the bound has to be applied here. Truncated rather than rejected, to
 * match the other intake paths: a staff member pasting a long note should get
 * their request filed, not an error.
 */
const MAX_VENDOR_NAME_CHARS = 200;
const MAX_PURPOSE_CHARS = 4_000;
const MAX_DATA_DESCRIPTION_CHARS = 8_000;

export interface NewVendorRequestInput {
  vendorName: string;
  purpose: string;
  dataDescription: string | null;
}

export interface SavedVendorRequest {
  id: string;
  vendorName: string;
  purpose: string;
  dataDescription: string | null;
}

export function parseNewVendorRequestInput(raw: unknown): NewVendorRequestInput {
  const body = isRecord(raw) ? raw : {};
  const vendorName = textField(body.vendorName).slice(0, MAX_VENDOR_NAME_CHARS);
  const purpose = textField(body.purpose).slice(0, MAX_PURPOSE_CHARS);

  if (!vendorName) throw new AiRuntimeError(400, "Vendor name is required");
  if (!purpose) throw new AiRuntimeError(400, "Purpose is required");

  return {
    vendorName,
    purpose,
    dataDescription: optionalText(body.dataDescription, MAX_DATA_DESCRIPTION_CHARS),
  };
}

export function buildVendorRequestSuggestionRequest(
  request: SavedVendorRequest
): AiSuggestionRequest {
  const sourceText = [
    `Vendor: ${request.vendorName}`,
    `Purpose: ${request.purpose}`,
    request.dataDescription ? `Data involved: ${request.dataDescription}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "register_intake",
    sourceText,
    sourceLabel: `${request.vendorName} vendor request`,
    titleHint: `${request.vendorName} vendor request review`,
    instruction:
      "Review this new-vendor request for ROPA impact. Identify likely register fields, " +
      "what is still unknown, whether vendor evidence or a questionnaire is needed, and any DPIA risk signals. " +
      "Do not create final register wording unless the requester stated it.",
    processingActivityId: null,
    dpiaId: null,
    vendorDocumentId: null,
    vendorQuestionnaireId: null,
    vendorQuestionnaireResponseId: null,
    vendorRequestId: request.id,
    softwareDiscoverySignalId: null,
    generatedDocumentDraftId: null,
  };
}

function optionalText(value: unknown, maxChars: number): string | null {
  const text = textField(value).slice(0, maxChars);
  return text.length > 0 ? text : null;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
