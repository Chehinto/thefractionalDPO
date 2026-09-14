/**
 * Create another client workspace for the fractional DPO.
 *
 * The tenant name and legal basis are entered here, but the creator identity is
 * resolved from the server session. A request cannot name somebody else as the
 * founding DPO.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { LEGAL_BASES, LEGAL_BASIS_LABELS, type LegalBasis } from "@/lib/legal-basis";
import { requireSession, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  let session;
  try {
    session = await requireSession();
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    return <SignInPrompt />;
  }

  async function createTenant(formData: FormData) {
    "use server";

    const current = await requireSession();
    const name = String(formData.get("name") ?? "").trim();
    const legalBasis = String(formData.get("legalBasis") ?? "") as LegalBasis;

    if (!name) throw new Error("A workspace name is required");
    if (!LEGAL_BASES.includes(legalBasis)) {
      throw new Error("Tell us why this company has a DPO");
    }

    const client = await requestClient();
    const { data, error } = await client.rpc("create_tenant", {
      p_caller_person_id: current.personId,
      p_tenant_name: name,
      p_legal_basis: legalBasis,
    });
    if (error) throw new Error(error.message);

    redirect(`/tenants/${(data as { id: string }).id}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/" className="text-sm text-slate-600 underline">
        ← Portfolio
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">New tenant</p>
        <h1 className="mt-1 text-2xl font-semibold">Create a client workspace</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="signed-in-as">
          Signed in as {session.email}
        </p>
      </header>

      <form action={createTenant} className="mt-6 space-y-5" data-testid="new-tenant-form">
        <label className="block text-sm">
          <span className="font-medium text-slate-800">Client company</span>
          <input
            name="name"
            required
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
            data-testid="new-tenant-name"
          />
        </label>

        <fieldset className="space-y-2 text-sm">
          <legend className="font-medium text-slate-800">Why does this company have a DPO?</legend>
          {LEGAL_BASES.map((basis) => (
            <label key={basis} className="flex items-start gap-2">
              <input type="radio" name="legalBasis" value={basis} required className="mt-1" />
              <span>{LEGAL_BASIS_LABELS[basis]}</span>
            </label>
          ))}
        </fieldset>

        <button
          type="submit"
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white"
          data-testid="submit-new-tenant"
        >
          Create workspace
        </button>
      </form>
    </main>
  );
}

function SignInPrompt() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Fractional DPO</h1>
      <p className="mt-4">
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
