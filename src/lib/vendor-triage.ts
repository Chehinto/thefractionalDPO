import "server-only";

import { AiRuntimeError, type Confidence } from "./ai-suggestion-runtime";

/**
 * Ask a model what a piece of software is, and how worried a DPO should be.
 *
 * The premise, and the reason nothing is fetched: a model already knows what
 * Notion, Xero or Slack are. Retrieving the vendor's own site would add a
 * server-side request forgery surface to learn something the model can already
 * say — so `homepageUrl` travels as context a human can open, never as
 * something this code reads.
 *
 * Everything that comes back is recollection, not evidence, and the schema
 * makes `stated` unrepresentable for that reason. The prompt below therefore
 * spends most of its length on one instruction: say you do not know. An
 * obscure or internal tool is exactly where a confident summary gets invented,
 * and an invented summary is worse than a blank one because it looks like work
 * already done.
 */

export const TRIAGE_VERDICTS = [
  "no_risk_identified",
  "dpia_recommended",
  "high_risk_mitigation_required",
] as const;

export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

/** What a DPO reads on screen. The wording carries the uncertainty. */
export const TRIAGE_VERDICT_LABELS: Record<TriageVerdict, string> = {
  no_risk_identified: "No risk identified",
  dpia_recommended: "DPIA recommended",
  high_risk_mitigation_required: "High risk — mitigation required",
};

export const TRIAGE_VERDICT_MEANINGS: Record<TriageVerdict, string> = {
  no_risk_identified:
    "We looked and did not see a risk. That is not the same as there being none — it is a screen over what a model recalls, not an assessment of your use of it.",
  dpia_recommended:
    "Enough signal that an Article 35 assessment should actually be done, rather than skipped on the basis that this looks ordinary.",
  high_risk_mitigation_required:
    "High risk. Mitigation required, and possible ICO consultation — Article 36 turns on the risk left AFTER mitigations, which have not been decided yet.",
};

export interface TriageRequest {
  softwareName: string;
  vendorName: string | null;
  homepageUrl: string | null;
  /** The line from the export or the request that prompted this. */
  sourceContext: string;
}

export interface TriageDraft {
  whatItDoes: string | null;
  whatItProcesses: string | null;
  verdict: TriageVerdict | null;
  verdictRationale: string | null;
  /** Never `stated`; the database refuses that value on this table. */
  confidence: Exclude<Confidence, "stated">;
  confidenceScore: number;
  model: string;
  promptKey: string;
}

export const TRIAGE_PROMPT_KEY = "vendor_triage_v1";

export function buildTriagePrompt(request: TriageRequest): { system: string; user: string } {
  const system = [
    "You help a Data Protection Officer triage software that has been detected in a company.",
    "",
    "You are answering from your own knowledge of the product. You are NOT reading its website,",
    "and you must not pretend to. If you do not recognise the product, or you only half-recall it,",
    'say so: set "whatItDoes" to null and "verdict" to null. A blank answer is useful. An invented',
    "one is worse than useless, because it looks like work that has already been done.",
    "",
    "Do not describe what THIS company uses it for — you cannot know that. Describe what the",
    "product is, and what personal data it typically handles when a company uses it normally.",
    "",
    "Choose a verdict only if you actually recognise the product:",
    '  "no_risk_identified" — nothing about this product suggests high-risk processing.',
    '  "dpia_recommended" — it plausibly involves large-scale, sensitive, or monitoring-type',
    "      processing, so an Article 35 assessment should be done rather than skipped.",
    '  "high_risk_mitigation_required" — special-category data, systematic monitoring of people,',
    "      automated decisions with legal effects, or similar. Mitigation is required.",
    "",
    "Judge the product, not the company. Reply with only a JSON object, no prose and no code",
    'fence, with these keys: "whatItDoes" (string or null), "whatItProcesses" (string or null),',
    '"verdict" (one of the three strings above, or null), "verdictRationale" (string or null),',
    '"confidence" ("inferred" or "unknown"), "confidenceScore" (integer 0-100).',
  ].join("\n");

  const user = [
    `Software: ${request.softwareName}`,
    request.vendorName ? `Vendor: ${request.vendorName}` : null,
    // Given as context a human could check, explicitly not as something read.
    request.homepageUrl ? `Their website (not visited): ${request.homepageUrl}` : null,
    "How it was detected:",
    request.sourceContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

export function parseTriageOutput(raw: unknown, model: string): TriageDraft {
  if (!isRecord(raw)) throw new AiRuntimeError(502, "The AI provider returned invalid JSON");

  const confidence = raw.confidence === "inferred" ? "inferred" : "unknown";
  const verdict = TRIAGE_VERDICTS.includes(raw.verdict as TriageVerdict)
    ? (raw.verdict as TriageVerdict)
    : null;
  const score =
    typeof raw.confidenceScore === "number" && Number.isInteger(raw.confidenceScore)
      ? Math.min(Math.max(raw.confidenceScore, 0), 100)
      : 0;
  const rationale = optionalText(raw.verdictRationale);

  // A verdict without reasoning or without a score is refused rather than
  // stored: the database rejects it too, and a DPO cannot weigh a bare label.
  // Dropping the verdict is better than dropping the whole triage — the
  // summary is still worth reading.
  const reasoned = verdict !== null && rationale !== null && score > 0;

  return {
    whatItDoes: optionalText(raw.whatItDoes),
    whatItProcesses: optionalText(raw.whatItProcesses),
    verdict: reasoned ? verdict : null,
    verdictRationale: reasoned ? rationale : null,
    confidence,
    confidenceScore: reasoned ? score : 0,
    model,
    promptKey: TRIAGE_PROMPT_KEY,
  };
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  // Models answer "unknown" as prose surprisingly often when asked for null.
  if (/^(unknown|n\/?a|not known|i don'?t know)\.?$/i.test(text)) return null;
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
