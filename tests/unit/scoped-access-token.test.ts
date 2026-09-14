/**
 * Token generation and hashing. Pure logic, no database.
 */

import { describe, expect, it } from "vitest";
import {
  createScopedAccessToken,
  DEFAULT_SCOPED_ACCESS_DAYS,
  hashScopedAccessToken,
  MAX_SCOPED_ACCESS_DAYS,
  scopedAccessExpiry,
  scopedAccessTokenFromParam,
  scopedAccessTokenMatches,
} from "@/lib/scoped-access";

describe("token generation", () => {
  it("returns a URL-safe token and its hex hash, never the same value twice", () => {
    const a = createScopedAccessToken();
    const b = createScopedAccessToken();

    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // The whole point of storing a hash is that the stored value is not the
  // credential. If the token were recoverable from it, a database dump would be
  // a set of working links.
  it("does not carry the token in the hash", () => {
    const { token, tokenHash } = createScopedAccessToken();
    expect(tokenHash).not.toContain(token);
    expect(hashScopedAccessToken(token)).toBe(tokenHash);
  });

  it("matches a token against its own hash and nothing else", () => {
    const { token, tokenHash } = createScopedAccessToken();
    const other = createScopedAccessToken();

    expect(scopedAccessTokenMatches(token, tokenHash)).toBe(true);
    expect(scopedAccessTokenMatches(other.token, tokenHash)).toBe(false);
    expect(scopedAccessTokenMatches(token, "")).toBe(false);
  });
});

describe("expiry", () => {
  it("defaults to a short window", () => {
    const days = (Date.parse(scopedAccessExpiry()) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(DEFAULT_SCOPED_ACCESS_DAYS);
  });

  // The database rejects anything past the ceiling. Clamping here means a
  // caller asking for a year gets a shorter link rather than a constraint
  // violation they might route around.
  it("clamps to the database ceiling instead of failing", () => {
    const days = (Date.parse(scopedAccessExpiry(365)) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(MAX_SCOPED_ACCESS_DAYS);
  });

  it("never issues a link that is already dead", () => {
    expect(Date.parse(scopedAccessExpiry(0))).toBeGreaterThan(Date.now());
    expect(Date.parse(scopedAccessExpiry(-5))).toBeGreaterThan(Date.now());
  });
});

describe("reading a token out of a URL", () => {
  it("accepts a real token and refuses anything that cannot be one", () => {
    const { token } = createScopedAccessToken();

    expect(scopedAccessTokenFromParam(token)).toBe(token);
    expect(scopedAccessTokenFromParam(`  ${token}  `)).toBe(token);
    expect(scopedAccessTokenFromParam("short")).toBeNull();
    expect(scopedAccessTokenFromParam("has spaces in it here")).toBeNull();
    expect(scopedAccessTokenFromParam("../../etc/passwd")).toBeNull();
    expect(scopedAccessTokenFromParam(null)).toBeNull();
    expect(scopedAccessTokenFromParam(undefined)).toBeNull();
  });
});
