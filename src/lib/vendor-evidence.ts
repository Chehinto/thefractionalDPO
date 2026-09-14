import {
  type AiSuggestionRequest,
  AiRuntimeError,
} from "./ai-suggestion-runtime";

export const VENDOR_DOCUMENT_TYPES = [
  "privacy_policy",
  "terms",
  "cookie_policy",
  "dpa",
  "subprocessors",
  "security_page",
  "questionnaire_response",
  "other",
] as const;

export type VendorDocumentType = (typeof VENDOR_DOCUMENT_TYPES)[number];

export interface VendorEvidenceInput {
  vendorName: string;
  documentType: VendorDocumentType;
  title: string | null;
  sourceUrl: string | null;
  content: string;
  processingActivityId: string | null;
}

export interface SavedVendorEvidence {
  id: string;
  vendorName: string;
  documentType: VendorDocumentType;
  title: string | null;
  sourceUrl: string | null;
  content: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VENDOR_DOCUMENT_CHARS = 80_000;

export function parseVendorEvidenceInput(raw: unknown): VendorEvidenceInput {
  const body = isRecord(raw) ? raw : {};
  const vendorName = textField(body.vendorName);
  const documentType = body.documentType;
  const content = textField(body.content).slice(0, MAX_VENDOR_DOCUMENT_CHARS);

  if (!vendorName) throw new AiRuntimeError(400, "Vendor name is required");
  if (!VENDOR_DOCUMENT_TYPES.includes(documentType as VendorDocumentType)) {
    throw new AiRuntimeError(400, "Choose a known vendor document type");
  }
  if (!content) throw new AiRuntimeError(400, "Document text is required");

  return {
    vendorName,
    documentType: documentType as VendorDocumentType,
    title: optionalText(body.title),
    sourceUrl: optionalText(body.sourceUrl),
    content,
    processingActivityId: optionalUuid(body.processingActivityId, "processingActivityId"),
  };
}

export function buildVendorFirstViewSuggestionRequest(
  document: SavedVendorEvidence
): AiSuggestionRequest {
  return {
    kind: "vendor_first_view",
    sourceText: document.content,
    sourceLabel: sourceLabelFor(document),
    titleHint: `${document.vendorName} first view`,
    instruction:
      "Create a DPO review note from this vendor document. Focus on purposes, roles, " +
      "data categories, data subjects, subprocessors, international transfers, retention, " +
      "security measures, cookies/tracking, risk signals and gaps that may require a vendor questionnaire. " +
      "Do not state a fact as certain unless the cited source text states it.",
    processingActivityId: null,
    dpiaId: null,
    vendorDocumentId: document.id,
    vendorQuestionnaireId: null,
    vendorQuestionnaireResponseId: null,
    vendorRequestId: null,
    softwareDiscoverySignalId: null,
    generatedDocumentDraftId: null,
  };
}

export function sourceLabelFor(document: SavedVendorEvidence): string {
  return [document.vendorName, document.title || labelForDocumentType(document.documentType)]
    .filter(Boolean)
    .join(" — ");
}

export function labelForDocumentType(type: VendorDocumentType): string {
  return type.replaceAll("_", " ");
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
