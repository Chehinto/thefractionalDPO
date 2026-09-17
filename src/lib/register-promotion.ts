/**
 * Turning a reviewed AI suggestion into a register draft (design resume §9).
 *
 * This is the step the product was missing. Detection worked — an accounting
 * export or a staff vendor request became a suggestion, and a DPO could mark it
 * reviewed — but marking it reviewed was only ever a stamp, so the Article 30
 * register stayed empty. This closes that loop without breaking the rule that
 * makes it safe: what lands is a `pending_dpo_review` draft, never an approved
 * row. `approve_processing_activity` remains the human step.
 *
 * The prefill is the interesting part, and it is deliberately stingy. §9 defines
 * `stated` as "a person directly said this, or a document explicitly states it
 * in terms that require no interpretation", and says an `inferred` value "cannot
 * silently become stated". So what a source actually establishes decides the
 * tag, and the two sources establish very different things:
 *
 *   A vendor request was typed by a colleague who wanted to use the thing. They
 *   stated the vendor and the purpose. That is `stated`.
 *
 *   A discovery signal is a line in an accounting export. It establishes that
 *   money went to a company — nothing about why, who is affected, or for how
 *   long. The vendor is `stated` (the export names it); the purpose is
 *   `unknown`, not a guess dressed up as a draft.
 *
 * Nothing here ever fills a field with a plausible-sounding value. §9: "Never
 * filled with a plausible-sounding guess. Flagged for the DPO, not defaulted."
 */

export type Confidence = "stated" | "inferred" | "unknown";

export interface SuggestionSource {
  kind: string;
  title: string;
  sourceLabel: string | null;
  sourceExcerpt: string;
  /** Set when the suggestion came from a colleague asking to use a vendor. */
  vendorRequest?: { vendorName: string; purpose: string; dataDescription: string | null } | null;
  /** Set when it came from an accounting or SSO export. */
  discoverySignal?: { softwareName: string; vendorName: string | null; signalText: string } | null;
}

export interface RegisterPrefill {
  purpose: string;
  purposeConfidence: Confidence;
  purposeEvidence: string | null;
  recipientVendor: string;
  recipientVendorConfidence: Confidence;
  recipientVendorEvidence: string | null;
  /** Always empty. §9: role is asserted by a person, never guessed. */
  role: "" | "controller" | "processor";
  retention: string;
  retentionConfidence: Confidence;
  /** Why the DPO is being asked to fill the gaps, in plain terms. */
  unestablished: string[];
}

export function prefillFromSuggestion(source: SuggestionSource): RegisterPrefill {
  if (source.vendorRequest) {
    const { vendorName, purpose, dataDescription } = source.vendorRequest;
    return {
      purpose,
      // A colleague wrote this sentence to explain what they wanted the vendor
      // for. That is a person directly saying it.
      purposeConfidence: "stated",
      purposeEvidence: `Stated in a vendor request: ${purpose}`,
      recipientVendor: vendorName,
      recipientVendorConfidence: "stated",
      recipientVendorEvidence: `Named in a vendor request by a colleague`,
      role: "",
      retention: "",
      retentionConfidence: "unknown",
      unestablished: [
        "Whether you are controller or processor for this activity",
        "Which categories of personal data are involved",
        "Whose data it is",
        "How long it is kept, and on what basis",
        ...(dataDescription ? [] : ["What data the requester expects the vendor to handle"]),
      ],
    };
  }

  if (source.discoverySignal) {
    const { softwareName, vendorName, signalText } = source.discoverySignal;
    return {
      // Left empty on purpose. A payment line does not say what the software is
      // used for, and a plausible guess here would be the exact failure §9
      // names: an inferred value silently becoming the record.
      purpose: "",
      purposeConfidence: "unknown",
      purposeEvidence: null,
      recipientVendor: vendorName ?? softwareName,
      // The export explicitly names who was paid. That much is stated.
      recipientVendorConfidence: "stated",
      recipientVendorEvidence: `Named in a source signal: ${signalText}`,
      role: "",
      retention: "",
      retentionConfidence: "unknown",
      unestablished: [
        "What this software is actually used for",
        "Whether it touches personal data at all",
        "Whether you are controller or processor for this activity",
        "Which categories of personal data are involved",
        "Whose data it is",
        "How long it is kept, and on what basis",
      ],
    };
  }

  // A suggestion with neither link — a generic intake note. Nothing about it is
  // established well enough to prefill, so nothing is.
  return {
    purpose: "",
    purposeConfidence: "unknown",
    purposeEvidence: null,
    recipientVendor: "",
    recipientVendorConfidence: "unknown",
    recipientVendorEvidence: source.sourceLabel ? `From ${source.sourceLabel}` : null,
    role: "",
    retention: "",
    retentionConfidence: "unknown",
    unestablished: [
      "What the processing is for",
      "Who receives the data, if anyone",
      "Whether you are controller or processor for this activity",
      "Which categories of personal data are involved",
      "Whose data it is",
      "How long it is kept, and on what basis",
    ],
  };
}

/**
 * The confidence tag for a multi-select field (data categories, data subjects),
 * decided by whether anything was actually selected.
 *
 * Empty means `unknown`, and that is the final answer rather than a placeholder.
 * An empty category array is never a fact about a processing activity — no real
 * activity processes no data about nobody — so it can only mean the question was
 * not answered. §9 forbids recording a gap as if it were an assertion: `stated`
 * means a person directly said this, and nobody says nothing. Tagging an empty
 * array `stated` also silently certifies "no special-category data", which is
 * what decides whether Article 35 requires a DPIA.
 *
 * So when the selection inputs arrive, this stays as it is: the tag follows the
 * selection, and an unanswered field keeps reading as the gap it is.
 *
 * Blank entries are treated as no selection, which is the fail-closed reading of
 * an ambiguous form submission.
 */
export function selectionConfidence(values: readonly string[]): Confidence {
  return values.some((value) => value.trim() !== "") ? "stated" : "unknown";
}

/**
 * A register draft cannot be created without the two things §9 says are never
 * guessed: a purpose (an entry with no purpose is not a record of anything) and
 * a role (always asserted).
 */
export function validateRegisterDraft(input: {
  purpose: string;
  role: string;
}): string | null {
  if (!input.purpose.trim()) {
    return "Say what the processing is for. An entry with no stated purpose is not a record of anything.";
  }
  if (input.role !== "controller" && input.role !== "processor") {
    return "Choose controller or processor. This one is never inferred — you assert it.";
  }
  return null;
}
