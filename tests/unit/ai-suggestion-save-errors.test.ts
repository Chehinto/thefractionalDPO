/**
 * How a failed write in the AI suggestion pipeline is reported to the caller.
 *
 * These mappings are the reason routes never hand a Postgres error message
 * back: the raw text names tables, columns and constraints, and a foreign key
 * pointing at another tenant's row would otherwise be reported as a distinct,
 * recognisable failure — which is the same enumeration oracle `requireMembership`
 * exists to close.
 */

import { describe, expect, it } from "vitest";
import {
  messageForAiSuggestionSaveError,
  statusForAiSuggestionSaveError,
} from "@/lib/save-ai-suggestion";

describe("foreign key violations (23503)", () => {
  it("reads as Not found, never as a reference to another tenant's row", () => {
    expect(statusForAiSuggestionSaveError("23503")).toBe(404);
    expect(messageForAiSuggestionSaveError("23503")).toBe("Not found");
  });

  it("stays Not found even when the caller supplies its own fallback wording", () => {
    expect(
      messageForAiSuggestionSaveError("23503", "The vendor request could not be saved")
    ).toBe("Not found");
  });
});

describe("policy violations (42501)", () => {
  it("reports a read-only workspace as a conflict rather than a hard failure", () => {
    expect(statusForAiSuggestionSaveError("42501")).toBe(409);
    expect(messageForAiSuggestionSaveError("42501")).toBe("This workspace cannot be written to");
  });
});

describe("everything else", () => {
  it("falls back to wording that names the row the caller was writing", () => {
    expect(statusForAiSuggestionSaveError("23514")).toBe(400);
    expect(messageForAiSuggestionSaveError("23514")).toBe("The AI suggestion could not be saved");
    expect(
      messageForAiSuggestionSaveError("23514", "The vendor request could not be saved")
    ).toBe("The vendor request could not be saved");
    expect(
      messageForAiSuggestionSaveError(undefined, "The software discovery signal could not be saved")
    ).toBe("The software discovery signal could not be saved");
  });
});
