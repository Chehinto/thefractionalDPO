/**
 * What a source actually establishes, and therefore what may be prefilled.
 *
 * §9 defines the confidence tags and says an inferred value "cannot silently
 * become stated". These tests are mostly about the fields that stay EMPTY: the
 * failure this guards against is a plausible-looking draft where a model's
 * guess has quietly become the company's Article 30 record.
 */

import { describe, expect, it } from "vitest";
import {
  prefillFromSuggestion,
  selectionConfidence,
  validateRegisterDraft,
} from "@/lib/register-promotion";

const BASE = {
  kind: "register_intake",
  title: "Review ScreenCo",
  sourceLabel: "Vendor request",
  sourceExcerpt: "Vendor: ScreenCo",
};

describe("a vendor request a colleague typed", () => {
  const prefill = prefillFromSuggestion({
    ...BASE,
    vendorRequest: {
      vendorName: "ScreenCo",
      purpose: "Run criminal record checks for regulated roles",
      dataDescription: "Candidate identity and check results",
    },
  });

  // A person wrote both of these sentences to explain what they wanted.
  it("treats the vendor and purpose as stated, because a person said them", () => {
    expect(prefill.recipientVendor).toBe("ScreenCo");
    expect(prefill.recipientVendorConfidence).toBe("stated");
    expect(prefill.purpose).toBe("Run criminal record checks for regulated roles");
    expect(prefill.purposeConfidence).toBe("stated");
  });

  it("still refuses to guess the role or the retention", () => {
    expect(prefill.role).toBe("");
    expect(prefill.retention).toBe("");
    expect(prefill.retentionConfidence).toBe("unknown");
  });
});

describe("a line in an accounting export", () => {
  const prefill = prefillFromSuggestion({
    ...BASE,
    discoverySignal: {
      softwareName: "Notion",
      vendorName: "Notion Labs",
      signalText: "NOTION.SO monthly workspace subscription",
    },
  });

  // The export names who was paid. That much is explicit and needs no
  // interpretation, so it is stated.
  it("treats the vendor as stated, because the export names it", () => {
    expect(prefill.recipientVendor).toBe("Notion Labs");
    expect(prefill.recipientVendorConfidence).toBe("stated");
    expect(prefill.recipientVendorEvidence).toContain("NOTION.SO monthly workspace subscription");
  });

  // This is the important one. A payment proves money moved, not why. Filling
  // a purpose here would be exactly the "plausible-sounding guess" §9 forbids,
  // and it would arrive wearing the authority of a register entry.
  it("leaves the purpose empty and unknown, because a payment does not state one", () => {
    expect(prefill.purpose).toBe("");
    expect(prefill.purposeConfidence).toBe("unknown");
    expect(prefill.purposeEvidence).toBeNull();
  });

  it("says out loud that it does not even know personal data is involved", () => {
    expect(prefill.unestablished).toContain("Whether it touches personal data at all");
    expect(prefill.unestablished).toContain("What this software is actually used for");
  });
});

describe("a suggestion with no source record behind it", () => {
  it("prefills nothing at all", () => {
    const prefill = prefillFromSuggestion(BASE);
    expect(prefill.purpose).toBe("");
    expect(prefill.recipientVendor).toBe("");
    expect(prefill.purposeConfidence).toBe("unknown");
    expect(prefill.recipientVendorConfidence).toBe("unknown");
  });
});

describe("what a draft cannot be created without", () => {
  it("requires a purpose", () => {
    expect(validateRegisterDraft({ purpose: "   ", role: "controller" })).toContain(
      "not a record of anything"
    );
  });

  // §9: role "always asserted, never guessed". There is no default that would
  // be honest, so there is no default.
  it("requires the role to be asserted rather than defaulted", () => {
    expect(validateRegisterDraft({ purpose: "Payroll", role: "" })).toContain("never inferred");
    expect(validateRegisterDraft({ purpose: "Payroll", role: "maybe" })).toContain("never inferred");
    expect(validateRegisterDraft({ purpose: "Payroll", role: "processor" })).toBeNull();
  });
});

describe("the confidence tag on what the DPO selected", () => {
  // The bug this guards against: both tags were hardcoded "stated" while the
  // arrays were always empty, so every draft certified "no special-category
  // data" and the Article 35 screen read clean across the whole register.
  it("tags nothing selected as unknown, because an empty array is a gap, not a fact", () => {
    expect(selectionConfidence([])).toBe("unknown");
    expect(selectionConfidence(["", "   "])).toBe("unknown");
  });

  it("tags a selection as stated, because the DPO asserted it", () => {
    expect(selectionConfidence(["Contact details"])).toBe("stated");
    expect(selectionConfidence(["Contact details", "Health data"])).toBe("stated");
    expect(selectionConfidence(["", "Employees"])).toBe("stated");
  });

  // Categories are tagged across both arrays together: ticking only a special
  // category still means the question was answered.
  it("counts special categories alone as a selection", () => {
    const ordinary: string[] = [];
    const special = ["Health data"];
    expect(selectionConfidence([...ordinary, ...special])).toBe("stated");
  });

  // Data subjects are tagged on their own array, independently of categories.
  it("tags data subjects independently of data categories", () => {
    expect(selectionConfidence([])).toBe("unknown");
    expect(selectionConfidence(["Job applicants"])).toBe("stated");
  });
});
