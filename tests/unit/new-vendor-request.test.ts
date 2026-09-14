import { describe, expect, it } from "vitest";
import {
  buildVendorRequestSuggestionRequest,
  parseNewVendorRequestInput,
} from "@/lib/new-vendor-request";

describe("parseNewVendorRequestInput", () => {
  it("requires vendor and purpose", () => {
    expect(() => parseNewVendorRequestInput({ purpose: "Recruitment checks" })).toThrow(
      "Vendor name is required"
    );
    expect(() => parseNewVendorRequestInput({ vendorName: "ScreenCo" })).toThrow(
      "Purpose is required"
    );
  });

  it("trims the request fields", () => {
    expect(
      parseNewVendorRequestInput({
        vendorName: "  ScreenCo  ",
        purpose: "  Run criminal record checks  ",
        dataDescription: "  Candidate identity and results  ",
      })
    ).toEqual({
      vendorName: "ScreenCo",
      purpose: "Run criminal record checks",
      dataDescription: "Candidate identity and results",
    });
  });
});

describe("buildVendorRequestSuggestionRequest", () => {
  it("creates a register-intake review item linked to the vendor request", () => {
    const request = buildVendorRequestSuggestionRequest({
      id: "11111111-1111-4111-8111-111111111111",
      vendorName: "ScreenCo",
      purpose: "Run criminal record checks",
      dataDescription: "Candidate identity and results",
    });

    expect(request).toMatchObject({
      kind: "register_intake",
      sourceLabel: "ScreenCo vendor request",
      titleHint: "ScreenCo vendor request review",
      vendorRequestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request.sourceText).toContain("Vendor: ScreenCo");
    expect(request.instruction).toContain("ROPA impact");
  });
});

describe("input bounds", () => {
  // This is the only write path open below the Active DPO tier, and the text
  // reaches both a canonical row and a model prompt. The columns are unbounded
  // `text`, so nothing below this function would stop an arbitrarily long body.
  it("truncates oversized fields rather than rejecting the request", () => {
    const parsed = parseNewVendorRequestInput({
      vendorName: "S".repeat(5_000),
      purpose: "P".repeat(50_000),
      dataDescription: "D".repeat(50_000),
    });

    expect(parsed.vendorName).toHaveLength(200);
    expect(parsed.purpose).toHaveLength(4_000);
    expect(parsed.dataDescription).toHaveLength(8_000);
  });

  it("leaves ordinary-length fields untouched", () => {
    const parsed = parseNewVendorRequestInput({
      vendorName: "ScreenCo",
      purpose: "Run criminal record checks",
      dataDescription: null,
    });

    expect(parsed).toEqual({
      vendorName: "ScreenCo",
      purpose: "Run criminal record checks",
      dataDescription: null,
    });
  });
});
