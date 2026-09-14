"use client";

/**
 * Signup — deliberately unstyled beyond what makes it usable and testable.
 *
 * The onboarding screen is being redesigned later and §6's wording for the
 * legal-basis question is explicitly not settled, so anything spent on copy or
 * layout here would be written twice. What this page does need to be is
 * correct: the account, then the person row (resolved by trigger), then exactly
 * one workspace.
 */

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { browserClient } from "@/lib/supabase-browser";
import { LEGAL_BASES, LEGAL_BASIS_LABELS, type LegalBasis } from "@/lib/legal-basis";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [legalBasis, setLegalBasis] = useState<LegalBasis | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    // 1. The auth account. The trigger on auth.users resolves the person row as
    //    part of this, claiming an unclaimed roster entry if one matches.
    const { error: signUpError } = await browserClient().auth.signUp({ email, password });
    if (signUpError) {
      setError(signUpError.message);
      setBusy(false);
      return;
    }

    // 2. The workspace, through the shared create_tenant path. The person id is
    //    resolved from the session server-side; this request never sends one.
    const response = await fetch("/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantName, legalBasis }),
    });

    if (!response.ok) {
      setError((await response.json().catch(() => ({}))).error ?? "Could not create the workspace.");
      setBusy(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <section className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-5xl items-center gap-8 md:grid-cols-[1fr_26rem]">
        <div>
          <Link href="/" className="text-sm text-slate-600 underline">
            Fractional DPO
          </Link>
          <h1 className="mt-4 text-4xl font-semibold text-slate-950">Create the first workspace.</h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-slate-600">
            The first account creates one company workspace and records why that company has a DPO.
            That answer becomes part of the governance context, not a default hidden in code.
          </p>
        </div>

        <div className="rounded border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Create an account</h2>

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
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded border border-slate-300 px-3 py-2"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Company name
              <input
                id="tenantName"
                name="tenantName"
                type="text"
                required
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                className="rounded border border-slate-300 px-3 py-2"
              />
            </label>

            <fieldset className="flex flex-col gap-2 text-sm">
              {/* Required, with no preselected option. A default here would record
                  a legal position the company never stated — see §6. */}
              <legend className="mb-1">Why does this company have a DPO?</legend>
              {LEGAL_BASES.map((basis) => (
                <label key={basis} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="legalBasis"
                    value={basis}
                    required
                    checked={legalBasis === basis}
                    onChange={() => setLegalBasis(basis)}
                    className="mt-1"
                  />
                  <span>{LEGAL_BASIS_LABELS[basis]}</span>
                </label>
              ))}
            </fieldset>

            <button
              type="submit"
              disabled={busy}
              className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create account"}
            </button>
          </form>

          {error ? (
            <p role="alert" className="mt-4 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <p className="mt-5 text-sm text-slate-600">
            Already have an account?{" "}
            <Link href="/login" className="underline">
              Sign in
            </Link>
            .
          </p>
        </div>
      </section>
    </main>
  );
}
