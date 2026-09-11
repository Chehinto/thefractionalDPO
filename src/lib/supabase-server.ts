import "server-only";

/**
 * Supabase clients that may only ever run on the server.
 *
 * Split from the browser client by execution boundary, not by preference: the
 * browser client is imported by a client component, and a single shared module
 * pulled `next/headers` — and, worse, the service-role key — into the client
 * bundle.
 *
 * The `server-only` import above turns any future import of this file from a
 * client component into a build failure rather than a silent key leak. That is
 * the point of it; do not remove it to make an import "just work".
 *
 *   requestClient  — the signed-in user's own client. RLS applies.
 *   serviceClient  — bypasses RLS entirely. Every caller must do its own
 *                    authorisation, because the database will not do it here.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Reads the session from cookies on every request. Nothing is memoised across
 * requests on purpose: a cached client would carry a session whose membership
 * has since been revoked, and §4 specifies revocation as immediate.
 */
export async function requestClient() {
  const cookieStore = await cookies();
  return createServerClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list: { name: string; value: string; options?: CookieOptions }[]) => {
          try {
            for (const { name, value, options } of list) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a server component, where cookies are read-only.
            // Session refresh still happens in middleware, so this is safe to
            // swallow — but only here, and only for that reason.
          }
        },
      },
    }
  );
}

/**
 * No tenant filtering of any kind. Nothing in the request path should reach for
 * this; it exists for admin and maintenance work that must not depend on RLS.
 */
export function serviceClient() {
  return createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
