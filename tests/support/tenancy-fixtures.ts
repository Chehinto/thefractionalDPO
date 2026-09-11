/**
 * Test actors for the tenancy suite.
 *
 * An "actor" is a real auth user with a real signed-in Supabase client, so
 * every assertion below runs through the same RLS path production does. Tests
 * deliberately do not use the service-role client to read tenant data — that
 * bypasses RLS, which is the thing under test.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/** Provisioning only — creating auth users and asserting on rows RLS hides. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Actor {
  email: string;
  /** Browser tests sign in with this; API tests use the client below. */
  password: string;
  authUserId: string;
  personId: string;
  /** Signed in, RLS applies. Holds one access token for its whole lifetime. */
  client: SupabaseClient;
}

export async function createActor(label: string): Promise<Actor> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = randomUUID();
  const admin = adminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`could not create ${label}: ${error.message}`);

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in ${label}: ${signInError.message}`);

  const { data: person, error: personError } = await admin
    .from("people")
    .select("id")
    .eq("auth_user_id", data.user!.id)
    .single();
  if (personError) throw new Error(`no person row for ${label}: ${personError.message}`);

  return { email, password, authUserId: data.user!.id, personId: person.id as string, client };
}

export type LegalBasis = "mandatory" | "contractual" | "voluntary";

/**
 * Create a workspace owned by this actor, returning its id.
 *
 * The legal basis defaults HERE, in the test helper, so suites that are about
 * something else stay readable. `create_tenant` itself has no default and no
 * optional argument — §6 requires the answer to be captured, and a database
 * default would quietly record a legal position nobody stated.
 */
export async function createTenant(
  actor: Actor,
  name: string,
  legalBasis: LegalBasis = "voluntary"
): Promise<string> {
  const { data, error } = await actor.client.rpc("create_tenant", {
    p_caller_person_id: actor.personId,
    p_tenant_name: name,
    p_legal_basis: legalBasis,
  });
  if (error) throw new Error(`create_tenant failed: ${error.message}`);
  return (data as { id: string }).id;
}
