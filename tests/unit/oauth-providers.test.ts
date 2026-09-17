/**
 * Which OAuth buttons the sign-in page offers.
 *
 * The parser is the only gate between an env var and a rendered button, so
 * every malformed input it might see (unset, blank, stray whitespace, a
 * provider that isn't wired up, a duplicate) has to resolve to "no button
 * for it" rather than a thrown error or a button that 404s on click.
 */

import { describe, expect, it } from "vitest";
import { getEnabledOAuthProviders } from "@/lib/oauth-providers";

describe("unset or empty", () => {
  it("returns no providers when the variable is undefined", () => {
    expect(getEnabledOAuthProviders(undefined)).toEqual([]);
  });

  it("returns no providers when the variable is null", () => {
    expect(getEnabledOAuthProviders(null)).toEqual([]);
  });

  it("returns no providers for an empty string", () => {
    expect(getEnabledOAuthProviders("")).toEqual([]);
  });

  it("returns no providers for a string of only whitespace and commas", () => {
    expect(getEnabledOAuthProviders("  , ,  ")).toEqual([]);
  });
});

describe("unknown values", () => {
  // An unregistered provider must produce no button rather than a dead one,
  // so a typo or a provider not yet enabled in supabase/config.toml is
  // dropped rather than surfaced as an error.
  it("drops a value that is not a known provider", () => {
    expect(getEnabledOAuthProviders("facebook")).toEqual([]);
  });

  it("keeps known providers alongside an unknown one", () => {
    expect(getEnabledOAuthProviders("google,facebook")).toEqual(["google"]);
  });
});

describe("whitespace and casing", () => {
  it("tolerates surrounding whitespace around entries", () => {
    expect(getEnabledOAuthProviders(" google , azure ")).toEqual(["google", "azure"]);
  });

  it("is case-insensitive", () => {
    expect(getEnabledOAuthProviders("Google,AZURE")).toEqual(["google", "azure"]);
  });
});

describe("duplicates", () => {
  it("collapses a repeated provider to a single entry", () => {
    expect(getEnabledOAuthProviders("google,google,azure")).toEqual(["google", "azure"]);
  });
});

describe("valid inputs", () => {
  it("returns a single enabled provider", () => {
    expect(getEnabledOAuthProviders("google")).toEqual(["google"]);
  });

  it("returns both providers", () => {
    expect(getEnabledOAuthProviders("google,azure")).toEqual(["google", "azure"]);
  });
});
