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
import Link from "next/link";
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
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <section className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-5xl items-center gap-8 md:grid-cols-[1fr_24rem]">
        <div>
          <Link href="/" className="text-sm text-slate-600 underline">
            Fractional DPO
          </Link>
          <h1 className="mt-4 text-4xl font-semibold text-slate-950">Welcome back.</h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-slate-600">
            Open the portfolio, review the pending AI suggestions, and keep every workspace moving
            from evidence to DPO decision.
          </p>
        </div>

        <div className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Sign in</h2>

          <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-4">
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
            <p role="alert" className="mt-4 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <p className="mt-5 text-sm text-slate-600">
            No account yet?{" "}
            <Link href="/signup" className="underline">
              Create one
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
