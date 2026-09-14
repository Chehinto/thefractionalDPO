/**
 * Day-to-day intake parsing.
 *
 * The route/page can stay thin if the product-specific interpretation lives
 * here: plain-English note in, constrained `register_intake` suggestion request
 * out. The AI runtime then handles provider calls and evidence validation.
 */

import { describe, expect, it } from "vitest";
import {
  buildDayToDayIntakeSuggestionRequest,
  parseDayToDayIntakeRequest,
} from "@/lib/day-to-day-intake";

describe("parseDayToDayIntakeRequest", () => {
  it("requires the operational note", () => {
    expect(() => parseDayToDayIntakeRequest({ note: "   " })).toThrow(
      "Tell us what changed"
    );
  });

  it("defaults the source label and trims input", () => {
    const parsed = parseDayToDayIntakeRequest({
      note: "  We started using ScreenCo for recruitment checks.  ",
    });

    expect(parsed).toEqual({
      note: "We started using ScreenCo for recruitment checks.",
      sourceLabel: "Day-to-day intake note",
      processingActivityId: null,
    });
  });

  it("validates an optional linked activity id", () => {
    expect(() =>
      parseDayToDayIntakeRequest({
        note: "We changed a vendor retention period.",
        processingActivityId: "not-a-uuid",
      })
    ).toThrow("processingActivityId must be a UUID");
  });
});

describe("buildDayToDayIntakeSuggestionRequest", () => {
  it("turns a note into a register-intake AI suggestion request", () => {
    const intake = parseDayToDayIntakeRequest({
      note: "We started using ScreenCo for criminal record checks.",
      sourceLabel: "Ops note",
    });
    const request = buildDayToDayIntakeSuggestionRequest(intake);

    expect(request).toMatchObject({
      kind: "register_intake",
      sourceText: "We started using ScreenCo for criminal record checks.",
      sourceLabel: "Ops note",
      titleHint: "Register intake draft",
      processingActivityId: null,
    });
    expect(request.instruction).toContain("Art. 30 register fields");
    expect(request.instruction).toContain("DPIA risk signals");
  });
});
