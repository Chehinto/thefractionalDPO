/**
 * Keeps the Supabase session cookies fresh on every request.
 *
 * This middleware refreshes tokens; it does NOT make access decisions. Tenant
 * access is decided in `src/lib/tenant-access.ts` and, underneath that, by RLS.
 * Putting a membership check here would be worse than useless: middleware runs
 * before the route knows which tenant it is dealing with, and a check that
 * looks like enforcement but isn't is how routes come to skip the real one.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list: { name: string; value: string; options?: CookieOptions }[]) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // Required: this call is what performs the refresh. Its result is
  // intentionally unused here — see the note above about not deciding access.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
