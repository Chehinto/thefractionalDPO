/**
 * Which OAuth providers to offer on the sign-in page.
 *
 * A provider only belongs in the list once someone has actually registered
 * an OAuth client for it and enabled it in `supabase/config.toml` (and, in
 * production, in the hosted project's auth settings). This module is the one
 * place in the app that decides what to show, so a provider can be turned on
 * or off per-environment by editing a single env var rather than a UI
 * component.
 */

export const OAUTH_PROVIDERS = ["google", "azure"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Parses a comma-separated `NEXT_PUBLIC_OAUTH_PROVIDERS` value into the list
 * of providers to render as sign-in buttons.
 *
 * Unknown values are dropped silently rather than throwing. This runs at
 * render time on every visitor's sign-in page: a typo or a provider that
 * hasn't been wired up yet in `supabase/config.toml` must fail closed into
 * "no button for it", never into a crashed page or a button that 404s when
 * clicked.
 */
export function getEnabledOAuthProviders(
  raw: string | undefined | null = process.env.NEXT_PUBLIC_OAUTH_PROVIDERS
): OAuthProvider[] {
  if (!raw) {
    return [];
  }

  const seen = new Set<OAuthProvider>();

  for (const entry of raw.split(",")) {
    const candidate = entry.trim().toLowerCase();
    if (candidate === "") {
      continue;
    }
    if (isOAuthProvider(candidate)) {
      seen.add(candidate);
    }
  }

  return Array.from(seen);
}
