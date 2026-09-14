/**
 * What this workspace has asked of you (design resume §4, tier 2).
 *
 * The first screen in this product built for someone who is not the DPO. It
 * requires membership of any tier — the register, DPIA and vendor pages all
 * require `active_dpo`, and this one deliberately does not, because a staff
 * member having a reason to open the product at all is the whole tier-2 thesis.
 *
 * It shows exactly what was pushed to this person and nothing else. There is no
 * tenant-wide query on this page: every read is already narrowed to the caller
 * by `assignment_read`, so a mistake here shows someone less than they are
 * owed, never more.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

interface TaskRow {
  id: string;
  kind: "scoped_question" | "policy_acknowledgment";
  title: string;
  body: string;
  why_asked: string | null;
  status: "pending" | "responded";
  response: string | null;
  responded_at: string | null;
}

export default async function MyTasksPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let access;
  try {
    access = await requireMembership(tenantId);
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const { data, error } = await supabase
    .from("assignment")
    .select("id, kind, title, body, why_asked, status, response, responded_at")
    .eq("tenant_id", tenantId)
    .eq("assignee_id", access.session.personId)
    .order("created_at", { ascending: false });

  async function respond(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId);
    const client = await requestClient();
    const { error: respondError } = await client.rpc("respond_to_assignment", {
      p_caller_person_id: current.session.personId,
      p_assignment_id: String(formData.get("assignmentId") ?? ""),
      p_response: String(formData.get("response") ?? ""),
    });
    if (respondError) throw new Error("That could not be saved");

    revalidatePath(`/tenants/${tenantId}/my-tasks`);
  }

  const tasks = (data ?? []) as unknown as TaskRow[];
  const pending = tasks.filter((task) => task.status === "pending");

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Your tasks</p>
        <h1 className="mt-1 text-2xl font-semibold">{access.membership.tenantName}</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="tasks-summary">
          {pending.length === 0
            ? "Nothing is waiting on you."
            : `${pending.length} thing${pending.length === 1 ? "" : "s"} waiting on you.`}
        </p>
        <p className="mt-2 text-sm text-slate-600">
          <Link
            href={`/tenants/${tenantId}/request-vendor`}
            className="underline"
            data-testid="tasks-request-vendor"
          >
            Want to use a new tool or supplier? Ask about it here.
          </Link>
        </p>
      </header>

      {error ? (
        <div
          className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
          data-testid="tasks-error"
        >
          <strong>Your tasks could not be loaded.</strong>
          <p className="mt-1">Treat this as unknown rather than none.</p>
        </div>
      ) : tasks.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="tasks-empty">
          Nothing has been asked of you in this workspace.
        </p>
      ) : (
        <ul className="mt-6 space-y-8" data-testid="task-list">
          {tasks.map((task) => (
            <li key={task.id} data-testid="task" data-status={task.status}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide ${
                    task.status === "pending"
                      ? "border-amber-300 bg-amber-50 text-amber-900"
                      : "border-emerald-300 bg-emerald-50 text-emerald-800"
                  }`}
                  data-testid="task-status"
                >
                  {task.status === "pending" ? "Waiting on you" : "Answered"}
                </span>
                <span className="text-xs uppercase tracking-wide text-slate-500">
                  {task.kind === "scoped_question" ? "Question" : "To read and confirm"}
                </span>
              </div>

              <h2 className="mt-2 font-medium" data-testid="task-title">
                {task.title}
              </h2>
              <p className="mt-1 text-sm text-slate-700" data-testid="task-body">
                {task.body}
              </p>
              {task.why_asked ? (
                <p className="mt-1 text-xs text-slate-500" data-testid="task-why">
                  Why you are being asked: {task.why_asked}
                </p>
              ) : null}

              {access.membership.tenantStatus === "active" ? (
                <form action={respond} className="mt-3 space-y-2">
                  <input type="hidden" name="assignmentId" value={task.id} />
                  <label className="sr-only" htmlFor={`response-${task.id}`}>
                    Your answer
                  </label>
                  <textarea
                    id={`response-${task.id}`}
                    name="response"
                    required
                    rows={3}
                    defaultValue={task.response ?? ""}
                    placeholder={
                      task.kind === "policy_acknowledgment"
                        ? "Confirm you have read it, and note anything that did not apply to you"
                        : "Say what you know. It is fine to say you are not sure."
                    }
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                    data-testid="task-response-input"
                  />
                  <button
                    type="submit"
                    className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                    data-testid="task-respond"
                  >
                    {task.status === "responded" ? "Update answer" : "Send to the DPO"}
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-xs text-amber-900" data-testid="tasks-read-only">
                  This workspace is read-only, so answers cannot be saved right now.
                </p>
              )}
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
