import { type AiSuggestionRequest, AiRuntimeError } from "./ai-suggestion-runtime";

/**
 * Discovery is the one intake path that fans out: the route makes a model call
 * and two inserts per signal, sequentially, inside a single request. Capping the
 * file size alone does not bound that — a 2 MB export is tens of thousands of
 * rows — so the row count is capped here, where every entry point passes
 * through. The number is set by what can finish inside one request, not by what
 * a spreadsheet can hold; larger exports are meant to be split.
 */
const MAX_DISCOVERY_SIGNALS = 100;

const TOO_MANY_SIGNALS = `Too many software signals in one request (limit ${MAX_DISCOVERY_SIGNALS}). Split the export and upload it in parts.`;

export const SOFTWARE_DISCOVERY_SOURCES = [
  "accounting_subscription",
  "accounting_payment",
  "sso_application",
] as const;

export type SoftwareDiscoverySource = (typeof SOFTWARE_DISCOVERY_SOURCES)[number];

export interface SoftwareDiscoverySignalInput {
  source: SoftwareDiscoverySource;
  sourceName: string;
  externalRef: string | null;
  softwareName: string;
  vendorName: string | null;
  signalText: string;
  amount: number | null;
  currency: string | null;
  occurredOn: string | null;
}

export interface SavedSoftwareDiscoverySignal extends SoftwareDiscoverySignalInput {
  id: string;
}

export function parseSoftwareDiscoveryInput(raw: unknown): SoftwareDiscoverySignalInput[] {
  const body = isRecord(raw) ? raw : {};
  const source = body.source;
  const sourceName = textField(body.sourceName);
  const signals = Array.isArray(body.signals) ? body.signals : null;

  if (!SOFTWARE_DISCOVERY_SOURCES.includes(source as SoftwareDiscoverySource)) {
    throw new AiRuntimeError(400, "Unknown software discovery source");
  }
  if (!sourceName) throw new AiRuntimeError(400, "Source name is required");
  if (!signals || signals.length === 0) {
    throw new AiRuntimeError(400, "At least one software signal is required");
  }
  if (signals.length > MAX_DISCOVERY_SIGNALS) {
    throw new AiRuntimeError(400, TOO_MANY_SIGNALS);
  }

  return signals.map((signal, index) => parseSignal(signal, source as SoftwareDiscoverySource, sourceName, index));
}

export async function parseSoftwareDiscoverySpreadsheetUpload(
  formData: FormData
): Promise<SoftwareDiscoverySignalInput[]> {
  const source = formData.get("source");
  const sourceName = textField(formData.get("sourceName"));
  const file = formData.get("file");

  if (!SOFTWARE_DISCOVERY_SOURCES.includes(source as SoftwareDiscoverySource)) {
    throw new AiRuntimeError(400, "Unknown software discovery source");
  }
  if (!sourceName) throw new AiRuntimeError(400, "Source name is required");
  if (!(file instanceof File) || file.size === 0) {
    throw new AiRuntimeError(400, "A CSV or TSV export file is required");
  }
  if (file.size > 2_000_000) {
    throw new AiRuntimeError(400, "Export file is too large");
  }

  const rows = rowsFromDelimitedExport(await file.arrayBuffer(), file.name);
  if (rows.length === 0) throw new AiRuntimeError(400, "The spreadsheet has no data rows");
  if (rows.length > MAX_DISCOVERY_SIGNALS) throw new AiRuntimeError(400, TOO_MANY_SIGNALS);

  return rows.map((row, index) =>
    parseSignal(row, source as SoftwareDiscoverySource, sourceName, index)
  );
}

export function buildSoftwareDiscoverySuggestionRequest(
  signal: SavedSoftwareDiscoverySignal
): AiSuggestionRequest {
  return {
    kind: "register_intake",
    sourceText: signalSourceText(signal),
    sourceLabel: `${signal.sourceName} ${labelForSource(signal.source)} signal`,
    titleHint: `${signal.softwareName} software discovery review`,
    instruction:
      "This source signal indicates software may be in use. Assess whether it is likely to process personal data, " +
      "which ROPA fields the DPO should ask about, whether it looks like a vendor/new processor, " +
      "and what evidence is missing. Do not create a register entry or state data categories as fact unless the source states them.",
    processingActivityId: null,
    dpiaId: null,
    vendorDocumentId: null,
    vendorQuestionnaireId: null,
    vendorQuestionnaireResponseId: null,
    vendorRequestId: null,
    softwareDiscoverySignalId: signal.id,
    generatedDocumentDraftId: null,
  };
}

export function signalSourceText(signal: SoftwareDiscoverySignalInput): string {
  return [
    `Source: ${signal.sourceName} (${labelForSource(signal.source)})`,
    signal.externalRef ? `External reference: ${signal.externalRef}` : null,
    `Software: ${signal.softwareName}`,
    signal.vendorName ? `Vendor: ${signal.vendorName}` : null,
    signal.amount !== null ? `Amount: ${signal.amount}${signal.currency ? ` ${signal.currency}` : ""}` : null,
    signal.occurredOn ? `Date: ${signal.occurredOn}` : null,
    `Signal: ${signal.signalText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function labelForSource(source: SoftwareDiscoverySource): string {
  return source.replaceAll("_", " ");
}

function parseSignal(
  raw: unknown,
  source: SoftwareDiscoverySource,
  sourceName: string,
  index: number
): SoftwareDiscoverySignalInput {
  if (!isRecord(raw)) throw new AiRuntimeError(400, `Signal ${index + 1} is invalid`);

  const softwareName =
    optionalText(raw.softwareName) ??
    pickText(raw, [
      "softwareName",
      "software",
      "appName",
      "app",
      "applicationName",
      "application",
      "product",
      "merchant",
      "payee",
      "name",
    ]) ??
    "";
  const signalText =
    optionalText(raw.signalText) ??
    optionalText(raw.description) ??
    optionalText(raw.transactionDescription) ??
    optionalText(raw.appLabel) ??
    pickText(raw, [
      "signalText",
      "transactionDescription",
      "appLabel",
      "description",
      "memo",
      "reference",
      "details",
      "merchant",
      "payee",
      "name",
    ]) ??
    "";

  if (!softwareName) throw new AiRuntimeError(400, `Signal ${index + 1} needs a software name`);
  if (!signalText) throw new AiRuntimeError(400, `Signal ${index + 1} needs source text`);

  return {
    source,
    sourceName,
    externalRef:
      optionalText(raw.externalRef) ??
      pickText(raw, ["externalRef", "id", "ref", "reference", "transactionId", "appId"]),
    softwareName,
    vendorName:
      optionalText(raw.vendorName) ??
      pickText(raw, ["vendorName", "vendor", "supplier", "merchant", "payee"]),
    signalText,
    amount: optionalNumber(raw.amount ?? valueFor(raw, ["total", "gross", "paid"])),
    currency: optionalText(raw.currency) ?? pickText(raw, ["curr"]),
    occurredOn: optionalIsoDate(
      raw.occurredOn ?? valueFor(raw, ["occurredOn", "date", "paidOn", "transactionDate", "lastLogin"])
    ),
  };
}

function rowsFromDelimitedExport(buffer: ArrayBuffer, fileName: string): Record<string, unknown>[] {
  const lower = fileName.toLowerCase();
  const delimiter = lower.endsWith(".tsv") ? "\t" : lower.endsWith(".csv") ? "," : null;
  if (delimiter === null) {
    throw new AiRuntimeError(400, "Export file must be CSV or TSV");
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const rows = parseDelimited(text, delimiter);
  const [header, ...body] = rows;
  if (!header) return [];

  const normalizedHeader = header.map((key) => normalizeKey(key));
  return body
    .map((cells) => {
      const row: Record<string, unknown> = {};
      normalizedHeader.forEach((key, index) => {
        if (key) row[key] = cells[index] ?? "";
      });
      return row;
    })
    .filter((row) => Object.values(row).some((value) => textField(value)));
}

function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.length > 0));
}

function pickText(row: Record<string, unknown>, keys: string[]): string | null {
  const value = valueFor(row, keys);
  return optionalText(value);
}

function valueFor(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (row[normalized] !== undefined && textField(row[normalized])) return row[normalized];
  }
  return undefined;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function optionalIsoDate(value: unknown): string | null {
  const text = optionalText(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AiRuntimeError(400, "occurredOn must be YYYY-MM-DD");
  }
  return text;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new AiRuntimeError(400, "amount must be a number");
  return number;
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
