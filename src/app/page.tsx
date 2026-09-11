/**
 * Deliberately minimal.
 *
 * The portfolio dashboard of §4 is not built yet — this only confirms that a
 * session resolved to a person, which is what the sign-in step of the isolation
 * test needs to assert before it starts attacking the API. It shows a count,
 * not a tenant list: rendering the portfolio here would be starting the feature
 * work this layer is supposed to precede.
 */

import Link from "next/link";
import { requireSession, TenantAccessError } from "@/lib/tenant-access";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let session = null;
  try {
    session = await requireSession();
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
  }

  if (!session) {
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

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Fractional DPO</h1>
      <p className="mt-4" data-testid="signed-in-as">
        Signed in as {session.email}
      </p>
      <p className="mt-2" data-testid="workspace-count">
        {session.memberships.length} workspace
        {session.memberships.length === 1 ? "" : "s"}
      </p>
    </main>
  );
}
