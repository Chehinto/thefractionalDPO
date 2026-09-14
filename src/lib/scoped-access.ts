import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Tier 3 link tokens (design resume §4).
 *
 * The token is generated here and hashed here; only the hash is ever sent to
 * Postgres. That is the difference between "the database stores a secret" and
 * "the database stores a fact about a secret" — a dump, a query log or a
 * `pg_stat_statements` row can't be replayed into a working link.
 *
 * The plaintext is returned exactly once, from `createScopedAccessToken`, and
 * there is deliberately no way to read it back afterwards. A DPO who loses the
 * link revokes it and issues another.
 */

/**
 * 256 bits. The token is the entire credential — there is no account, password
 * or second factor behind it — so it is sized to be unguessable rather than
 * typeable. Links are sent, not transcribed.
 */
const TOKEN_BYTES = 32;

/**
 * CLAUDE.md asks for short expirations by default. Fourteen days is the default
 * because a vendor security questionnaire realistically round-trips in one or
 * two weeks; the database caps any grant at 90 days regardless of what is
 * passed here, so this value can be loosened without loosening the ceiling.
 */
export const DEFAULT_SCOPED_ACCESS_DAYS = 14;
export const MAX_SCOPED_ACCESS_DAYS = 90;

export interface NewScopedAccessToken {
  /** Shown to the DPO once, to paste into an email. Never stored. */
  token: string;
  /** Lowercase hex sha256. This is what the database gets. */
  tokenHash: string;
}

export function createScopedAccessToken(): NewScopedAccessToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashScopedAccessToken(token) };
}

export function hashScopedAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a presented token matches a known hash.
 *
 * Not used by the redemption path — that compares hashes inside Postgres via a
 * unique index, which is a different and better trade (one indexed lookup
 * instead of a scan). This exists for any comparison that happens in Node, so
 * that one is constant-time rather than bailing on the first differing byte.
 */
export function scopedAccessTokenMatches(token: string, expectedHash: string): boolean {
  const presented = Buffer.from(hashScopedAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * When a link issued now should stop working.
 *
 * Clamped to the database ceiling here as well as there. The constraint is the
 * enforcement boundary; this makes a caller asking for a year fail as a shorter
 * link rather than as a constraint violation they might be tempted to work
 * around.
 */
export function scopedAccessExpiry(days: number = DEFAULT_SCOPED_ACCESS_DAYS): string {
  const capped = Math.min(Math.max(days, 1), MAX_SCOPED_ACCESS_DAYS);
  return new Date(Date.now() + capped * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Pull a token out of a URL path segment.
 *
 * Returns null rather than throwing on anything that cannot be a token, so the
 * caller answers a malformed link and an unknown one with the same 404 — the
 * distinction would tell a stranger whether they had the right shape.
 */
export function scopedAccessTokenFromParam(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(trimmed)) return null;
  return trimmed;
}
