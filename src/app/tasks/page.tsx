/**
 * What every workspace has asked of you, in one place.
 *
 * Deliberately not part of the portfolio. §4 makes the portfolio exactly the
 * Active DPO list — the workspaces someone is responsible for — and a staff
 * membership is not that. This page answers the other question, "where am I
 * being asked for things", and naming workspaces here is fine precisely because
 * nothing on this page implies responsibility for them.
 *
 * Every read is narrowed to the caller's own rows before RLS is reached, and
 * `assignment_read` narrows again. A staff member must never learn that anyone
 * else was asked anything, so a mistake here shows them less than they are
 * owed, never more.
 */

import Link from "next/link";
import { requireSession, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

interface TaskRow {
  id: string;
  tenant_id: string;
  title: string;
  status: "pending" | "responded";
}

export default async function TasksPage() {
  let session;
  try {
    session = await requireSession();
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    return <SignInPrompt />;
  }

  const supabase = await requestClient();
  const { data, error } = await supabase
    .from("assignment")
    .select("id, tenant_id, title, status")
    .eq("assignee_id", session.personId)
    .order("created_at", { ascending: false });

  const tasks = (data ?? []) as unknown as TaskRow[];

  // Every workspace the caller belongs to, whether or not it has asked them
  // anything. A workspace with nothing waiting still belongs on this list —
  // "nothing is waiting on you here" is an answer, and its absence would read
  // as the workspace being gone.
  const workspaces = session.memberships.map((membership) => {
    const mine = tasks.filter((task) => task.tenant_id === membership.tenantId);
    return {
      membership,
      pending: mine.filter((task) => task.status === "pending").length,
      total: mine.length,
    };
  });

  const totalPending = workspaces.reduce((sum, w) => sum + w.pending, 0);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/" className="text-sm text-slate-600 hover:underline" data-testid="back-to-portfolio">
        ← Portfolio
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Your tasks</p>
        <h1 className="mt-1 text-2xl font-semibold">What is waiting on you</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="tasks-total">
          {error
            ? "Your tasks could not be loaded."
            : totalPending === 0
              ? "Nothing is waiting on you."
              : `${totalPending} thing${totalPending === 1 ? "" : "s"} across ${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}.`}
        </p>
      </header>

      {error ? (
        <div
          className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
          data-testid="tasks-index-error"
        >
          <strong>Your tasks could not be loaded.</strong>
          <p className="mt-1">Treat this as unknown rather than none.</p>
        </div>
      ) : workspaces.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="tasks-index-empty">
          You are not a member of any workspace.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200" data-testid="tasks-workspace-list">
          {workspaces.map(({ membership, pending, total }) => (
            <li
              key={membership.membershipId}
              className="flex flex-wrap items-center justify-between gap-2 py-4"
              data-testid="tasks-workspace"
            >
              <div>
                <p className="font-medium" data-testid="tasks-workspace-name">
                  {membership.tenantName}
                </p>
                <p className="text-sm text-slate-600" data-testid="tasks-workspace-state">
                  {pending > 0
                    ? `${pending} waiting on you`
                    : total > 0
                      ? "All answered"
                      : "Nothing waiting"}
                </p>
              </div>
              <Link
                href={`/tenants/${membership.tenantId}/my-tasks`}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                data-testid="open-workspace-tasks"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
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
