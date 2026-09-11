/**
 * Session → membership resolution. The server-side answer to "what can this
 * caller actually reach", and the only place a route should ask.
 *
 * This is the equivalent of AxioVendo's `requireMember`, with one structural
 * difference that drives everything else: there, a person had exactly one
 * organisation, read from `users.org_id`. Here a person holds a list of live
 * memberships across many tenants — a fractional DPO's portfolio — so the
 * question is never "which tenant is this person in" but "is this person in
 * THIS tenant, right now".
 *
 * Three rules hold the layer together:
 *
 *  1. A tenant id from the client is never trusted. It is only ever used to
 *     look up whether the session has a live membership for it. A request may
 *     name any tenant it likes; naming one grants nothing.
 *  2. Resolution is a live database read on every call. Nothing is cached in
 *     module scope, in a request-scoped memo, or in the JWT — see the note on
 *     token claims below.
 *  3. A tenant the caller cannot reach is reported as missing, not forbidden.
 *
 * This layer is defence in depth, not the enforcement boundary. RLS in
 * `0001_tenancy.sql` is the enforcement boundary; if every check here were
 * deleted, the database would still return nothing. Both exist so that a
 * regression in one is not sufficient to leak a tenant.
 */

import { NextResponse } from "next/server";
import { requestClient } from "./supabase-server";

export type MembershipTier = "active_dpo" | "staff" | "external_scoped";
export type TenantStatus = "active" | "read_only" | "suspended";

export interface Membership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: TenantStatus;
  tier: MembershipTier;
  activeFrom: string;
  activeTo: string | null;
}

export interface CallerSession {
  authUserId: string;
  personId: string;
  email: string;
  /** Live memberships only. An empty list is normal, not an error. */
  memberships: Membership[];
}

export interface TenantAccess {
  session: CallerSession;
  membership: Membership;
}

/**
 * 401 means "we do not know who you are". 404 means "there is no such tenant,
 * as far as you are concerned" — used both for a tenant that does not exist and
 * one the caller has no live membership in, because a response that could tell
 * those apart is an oracle for enumerating other companies' workspaces.
 */
export class TenantAccessError extends Error {
  constructor(
    readonly status: 401 | 404,
    message: string
  ) {
    super(message);
    this.name = "TenantAccessError";
  }

  get response(): NextResponse {
    return NextResponse.json({ error: this.message }, { status: this.status });
  }
}

const NOT_FOUND = () => new TenantAccessError(404, "Not found");

/**
 * Who is calling, and every tenant they can currently reach.
 *
 * The membership list comes from `public.my_memberships()`, which runs as the
 * caller so that the row level security policies apply to it. The liveness rule
 * — what counts as a current membership — is defined once in SQL
 * (`app.is_live`) and deliberately not restated here: a second copy in
 * TypeScript is exactly how the database and the application would come to
 * disagree about whether a revoked DPO still has access.
 *
 * Deliberately NOT read from the JWT. Supabase access tokens live for about an
 * hour, so a membership claim baked into one would keep granting access for up
 * to an hour after revocation. §4 specifies removal as immediate and binary,
 * which rules out any token-carried copy of this state.
 */
export async function requireSession(): Promise<CallerSession> {
  const supabase = await requestClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new TenantAccessError(401, "Not signed in");

  const { data: person, error: personError } = await supabase
    .from("people")
    .select("id, email")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  // A session with no person row cannot be resolved to anything, so it reaches
  // nothing. Treated as unauthenticated rather than as an empty portfolio: the
  // two need different fixes, and silently returning "no tenants" would hide a
  // broken sign-up trigger behind a plausible-looking empty screen.
  if (personError || !person) throw new TenantAccessError(401, "Not signed in");

  const { data: rows, error } = await supabase.rpc("my_memberships");
  if (error) throw new Error(`Could not resolve memberships: ${error.message}`);

  const memberships: Membership[] = (rows ?? []).map((row: Record<string, unknown>) => ({
    membershipId: row.membership_id as string,
    tenantId: row.tenant_id as string,
    tenantName: row.tenant_name as string,
    tenantStatus: row.tenant_status as TenantStatus,
    tier: row.tier as MembershipTier,
    activeFrom: row.active_from as string,
    activeTo: (row.active_to as string | null) ?? null,
  }));

  return {
    authUserId: user.id,
    personId: person.id as string,
    email: person.email as string,
    memberships,
  };
}

/**
 * Confirm the caller holds a live membership in one specific tenant.
 *
 * `tenantId` comes from the URL, which is to say from the caller. It is matched
 * against the server-resolved list and never used to fetch anything before that
 * match succeeds.
 *
 * `tier` narrows further — passing it asks for that exact tier. A caller with
 * the wrong tier gets 404 rather than 403 for the same reason a non-member
 * does: telling a staff member that a resource exists but needs Active DPO
 * confirms the resource exists.
 */
export async function requireMembership(
  tenantId: string | null | undefined,
  options: { tier?: MembershipTier } = {}
): Promise<TenantAccess> {
  const session = await requireSession();

  if (!tenantId || !isUuid(tenantId)) throw NOT_FOUND();

  const membership = session.memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw NOT_FOUND();
  if (options.tier && membership.tier !== options.tier) throw NOT_FOUND();

  return { session, membership };
}

/**
 * Rejecting a malformed id before it reaches the database keeps a bad path
 * parameter from surfacing as a Postgres type error, which would answer a
 * different question ("that isn't a uuid") than the one we want answered
 * ("no such tenant").
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Turn a thrown TenantAccessError into its response; rethrow anything else. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof TenantAccessError) return e.response;
  throw e;
}
