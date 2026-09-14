/**
 * Vendor evidence intake.
 *
 * This is the product-specific layer before the generic AI runtime: validate
 * the DPO's pasted vendor source and build a first-view suggestion that links
 * back to the stored evidence row.
 */

import { describe, expect, it } from "vitest";
import {
  buildVendorFirstViewSuggestionRequest,
  parseVendorEvidenceInput,
  sourceLabelFor,
  type SavedVendorEvidence,
} from "@/lib/vendor-evidence";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("parseVendorEvidenceInput", () => {
  it("requires a vendor name, known document type and document text", () => {
    expect(() =>
      parseVendorEvidenceInput({ documentType: "privacy_policy", content: "Text" })
    ).toThrow("Vendor name is required");

    expect(() =>
      parseVendorEvidenceInput({ vendorName: "ScreenCo", documentType: "unknown", content: "Text" })
    ).toThrow("Choose a known vendor document type");

    expect(() =>
      parseVendorEvidenceInput({ vendorName: "ScreenCo", documentType: "privacy_policy" })
    ).toThrow("Document text is required");
  });

  it("trims optional metadata and validates linked activity ids", () => {
    const parsed = parseVendorEvidenceInput({
      vendorName: "  ScreenCo  ",
      documentType: "dpa",
      title: "  Data Processing Addendum  ",
      sourceUrl: "  https://screen.example/dpa  ",
      content: "  ScreenCo processes candidate data.  ",
      processingActivityId: UUID,
    });

    expect(parsed).toEqual({
      vendorName: "ScreenCo",
      documentType: "dpa",
      title: "Data Processing Addendum",
      sourceUrl: "https://screen.example/dpa",
      content: "ScreenCo processes candidate data.",
      processingActivityId: UUID,
    });

    expect(() =>
      parseVendorEvidenceInput({
        vendorName: "ScreenCo",
        documentType: "dpa",
        content: "Text",
        processingActivityId: "not-a-uuid",
      })
    ).toThrow("processingActivityId must be a UUID");
  });
});

describe("buildVendorFirstViewSuggestionRequest", () => {
  const document: SavedVendorEvidence = {
    id: UUID,
    vendorName: "ScreenCo",
    documentType: "privacy_policy",
    title: "ScreenCo Privacy Policy",
    sourceUrl: "https://screen.example/privacy",
    content:
      "ScreenCo processes candidate identity details and criminal record checks for regulated roles.",
  };

  it("links the AI first view back to the stored vendor document", () => {
    const request = buildVendorFirstViewSuggestionRequest(document);

    expect(request).toMatchObject({
      kind: "vendor_first_view",
      sourceText: document.content,
      sourceLabel: "ScreenCo — ScreenCo Privacy Policy",
      titleHint: "ScreenCo first view",
      vendorDocumentId: UUID,
    });
    expect(request.instruction).toContain("subprocessors");
    expect(request.instruction).toContain("vendor questionnaire");
  });

  it("builds a readable source label when no title was supplied", () => {
    expect(
      sourceLabelFor({
        ...document,
        title: null,
        documentType: "cookie_policy",
      })
    ).toBe("ScreenCo — cookie policy");
  });
});
