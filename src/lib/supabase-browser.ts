/**
 * The signed-in user's client, in their browser. RLS applies.
 *
 * Deliberately its own module. Server-side clients live in
 * `supabase-server.ts`, which is marked `server-only` — keeping them apart is
 * what stops `next/headers` and the service-role key reaching a client bundle.
 */

import { createBrowserClient } from "@supabase/ssr";

export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase browser environment is not configured");
  return createBrowserClient(url, anonKey);
}
