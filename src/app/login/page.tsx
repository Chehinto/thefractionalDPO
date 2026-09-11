"use client";

/**
 * Sign-in.
 *
 * Present at this stage because the tenant-isolation regression test needs a
 * real authenticated browser session to attack from — a session faked by
 * writing cookies would prove nothing about how the real one behaves. There is
 * no sign-up form yet: people arrive on a roster (§4 tier 2) or through the
 * Supabase admin API in tests.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { browserClient } from "@/lib/supabase-browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { error: signInError } = await browserClient().auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      // Deliberately not "no account with that address" — that would confirm
      // which addresses are registered to anyone who can reach this form.
      setError("Those details weren't recognised.");
      setBusy(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            id="email"
            name="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            id="password"
            name="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </main>
  );
}
