/**
 * The staff roster, and what has been asked of it (design resume §4, tier 2).
 *
 * Every live member is listed, including the ones with nothing assigned. That
 * is the whole reason §4 insists the roster is a maintained object rather than
 * one accumulated from whoever got pinged: you can only prove who did NOT
 * answer if you know who was there to be asked. A screen that listed only
 * people with assignments would quietly lose that.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { MEMBER_COLUMNS } from "@/lib/tenant-queue";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

interface MemberRow {
  tier: string;
  person: { id: string; email: string; full_name: string | null } | null;
}

interface AssignmentRow {
  id: string;
  assignee_id: string;
  kind: string;
  title: string;
  body: string;
  why_asked: string | null;
  status: "pending" | "responded";
  response: string | null;
  responded_at: string | null;
  created_at: string;
}

export default async function RosterPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const [{ data: memberRows, error: memberError }, { data: assignmentRows, error }] =
    await Promise.all([
      supabase
        .from("memberships")
        // MEMBER_COLUMNS names the foreign key. `memberships` points at `people`
        // twice — as the member and as whoever revoked them — so an unqualified
        // embed is ambiguous, PostgREST refuses the whole query, and the roster
        // comes back empty rather than erroring. The constant exists because
        // that has already happened once on another screen.
        .select(MEMBER_COLUMNS)
        .eq("tenant_id", tenantId)
        .is("active_to", null),
      supabase
        .from("assignment")
        .select(
          "id, assignee_id, kind, title, body, why_asked, status, response, responded_at, created_at"
        )
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }),
    ]);

  async function createAssignment(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    const client = await requestClient();
    const { error: assignError } = await client.rpc("assign_to_member", {
      p_caller_person_id: current.session.personId,
      p_tenant_id: tenantId,
      p_assignee_person_id: String(formData.get("assigneeId") ?? ""),
      p_kind: String(formData.get("kind") ?? "scoped_question"),
      p_title: String(formData.get("title") ?? ""),
      p_body: String(formData.get("body") ?? ""),
      p_why_asked: String(formData.get("whyAsked") ?? "") || null,
      p_due_at: null,
    });
    if (assignError) throw new Error("That could not be assigned");

    revalidatePath(`/tenants/${tenantId}/roster`);
  }

  // Staff first, then by name. The order matters because this list is also the
  // assignee dropdown, and an arbitrary order means its default is an arbitrary
  // person — most often the DPO themselves, since they hold the oldest
  // membership. Asking staff is the common case; defaulting to it is safer than
  // defaulting to whatever the planner returned first.
  const members = ((memberRows ?? []) as unknown as MemberRow[]).sort((a, b) => {
    const rank = (m: MemberRow) => (m.tier === "active_dpo" ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return nameOf(a).localeCompare(nameOf(b));
  });
  const loadFailed = Boolean(memberError) || Boolean(error);
  const assignments = (assignmentRows ?? []) as unknown as AssignmentRow[];

  const byAssignee = new Map<string, AssignmentRow[]>();
  for (const assignment of assignments) {
    const list = byAssignee.get(assignment.assignee_id) ?? [];
    list.push(assignment);
    byAssignee.set(assignment.assignee_id, list);
  }

  const outstanding = assignments.filter((a) => a.status === "pending").length;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-workspace"
      >
        ← Workspace
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Roster</p>
        <h1 className="mt-1 text-2xl font-semibold">People, and what you have asked them</h1>
        <p className="mt-1 text-sm text-slate-600" data-testid="roster-summary">
          {access.membership.tenantName} · {members.length} with access ·{" "}
          {outstanding === 0 ? "nothing outstanding" : `${outstanding} awaiting an answer`}
        </p>
      </header>

      {access.membership.tenantStatus === "active" ? (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Ask someone something</h2>
          <form action={createAssignment} className="mt-3 space-y-4" data-testid="assign-form">
            <div>
              <label htmlFor="assigneeId" className="block text-sm font-medium text-slate-800">
                Who
              </label>
              <select
                id="assigneeId"
                name="assigneeId"
                required
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="assign-assignee"
              >
                {members.map((member) => (
                  <option key={member.person!.id} value={member.person!.id}>
                    {nameOf(member)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="kind" className="block text-sm font-medium text-slate-800">
                What kind
              </label>
              <select
                id="kind"
                name="kind"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="assign-kind"
              >
                <option value="scoped_question">A question to answer</option>
                <option value="policy_acknowledgment">Something to read and confirm</option>
              </select>
            </div>

            <div>
              <label htmlFor="title" className="block text-sm font-medium text-slate-800">
                Title
              </label>
              <input
                id="title"
                name="title"
                required
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="assign-title"
              />
            </div>

            <div>
              <label htmlFor="body" className="block text-sm font-medium text-slate-800">
                The question, or what to read
              </label>
              <textarea
                id="body"
                name="body"
                required
                rows={3}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="assign-body"
              />
            </div>

            <div>
              <label htmlFor="whyAsked" className="block text-sm font-medium text-slate-800">
                Why you are asking
              </label>
              <textarea
                id="whyAsked"
                name="whyAsked"
                rows={2}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="assign-why"
              />
              <p className="mt-1 text-xs text-slate-500">
                They are not a privacy specialist. An assignment that does not say why it matters
                gets guessed at rather than answered.
              </p>
            </div>

            <button
              type="submit"
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
              data-testid="submit-assignment"
            >
              Assign
            </button>
          </form>
        </section>
      ) : (
        <p className="mt-6 text-sm text-amber-900" data-testid="roster-read-only">
          This workspace is read-only, so nothing new can be assigned.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Who has access</h2>
        {loadFailed ? (
          <div
            className="mt-3 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
            data-testid="roster-error"
          >
            <strong>The roster could not be loaded.</strong>
            <p className="mt-1">
              Treat this as unknown rather than none — an empty roster and a failed query mean very
              different things when the question is who has not answered.
            </p>
          </div>
        ) : null}

        <ul className="mt-3 divide-y divide-slate-200" data-testid="roster-list">
          {members.map((member) => {
            const mine = byAssignee.get(member.person!.id) ?? [];
            const waiting = mine.filter((a) => a.status === "pending").length;
            return (
              <li key={member.person!.id} className="py-5" data-testid="roster-member">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium" data-testid="roster-member-name">
                      {nameOf(member)}
                    </p>
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      {member.tier.replaceAll("_", " ")}
                    </p>
                  </div>
                  <span className="text-sm text-slate-600" data-testid="roster-member-state">
                    {mine.length === 0
                      ? "Nothing asked"
                      : waiting > 0
                        ? `${waiting} awaiting an answer`
                        : "All answered"}
                  </span>
                </div>

                {mine.length > 0 ? (
                  <ul className="mt-3 space-y-3">
                    {mine.map((assignment) => (
                      <li
                        key={assignment.id}
                        className="rounded border border-slate-200 px-3 py-2"
                        data-testid="roster-assignment"
                        data-status={assignment.status}
                      >
                        <p className="text-sm font-medium" data-testid="roster-assignment-title">
                          {assignment.title}
                        </p>
                        <p className="mt-0.5 text-sm text-slate-600">{assignment.body}</p>
                        {assignment.status === "responded" ? (
                          <p
                            className="mt-2 border-l-2 border-emerald-300 pl-2 text-sm text-slate-800"
                            data-testid="roster-assignment-response"
                          >
                            {assignment.response}
                          </p>
                        ) : (
                          <p className="mt-2 text-xs text-amber-900" data-testid="roster-assignment-pending">
                            No answer yet
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

function nameOf(member: MemberRow): string {
  return member.person?.full_name ?? member.person?.email ?? "Unknown";
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
