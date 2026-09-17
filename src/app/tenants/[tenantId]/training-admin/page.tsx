/**
 * Training, from the DPO's side: draft it, review it, send it, see who has done it.
 *
 * The order on this screen is the order of the decision. A generated module is
 * a DRAFT — it appears here and nowhere else until a human publishes it, which
 * stamps their name on it. That is CLAUDE.md's rule about AI output, applied to
 * the one place a model's words are read by staff as their employer's
 * instruction: a wrong register draft costs a DPO an afternoon, wrong published
 * training teaches thirty people the wrong thing and generates a record saying
 * they were trained correctly.
 *
 * Completion is the last section because it is the question the record exists
 * to answer, and it lists everyone — including the people who have not started.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { MEMBER_COLUMNS } from "@/lib/tenant-queue";
import { generateTrainingDraft } from "@/lib/generate-training";
import { AiRuntimeError } from "@/lib/ai-suggestion-runtime";

export const dynamic = "force-dynamic";

interface ModuleRow {
  id: string;
  title: string;
  body: string;
  pass_mark: number;
  estimated_minutes: number;
  published: boolean;
  source: string;
  reviewed_by: string | null;
}

interface AttemptRow {
  module_id: string;
  person_id: string;
  score: number;
  passed: boolean;
}

interface MemberRow {
  tier: string;
  person: { id: string; email: string; full_name: string | null } | null;
}

export default async function TrainingAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { tenantId } = await params;
  const { error: formError, sent } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const [{ data: moduleRows }, { data: attemptRows }, { data: memberRows }] = await Promise.all([
    supabase
      .from("training_module")
      .select("id, title, body, pass_mark, estimated_minutes, published, source, reviewed_by")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }),
    supabase
      .from("training_attempt")
      .select("module_id, person_id, score, passed")
      .eq("tenant_id", tenantId),
    supabase.from("memberships").select(MEMBER_COLUMNS).eq("tenant_id", tenantId).is("active_to", null),
  ]);

  async function draftModule(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only, so training cannot be drafted");
    }

    const topic = String(formData.get("topic") ?? "").trim();
    if (!topic) {
      redirect(`/tenants/${tenantId}/training-admin?error=${encodeURIComponent("What should it cover?")}`);
    }

    let draft;
    try {
      draft = await generateTrainingDraft({
        topic,
        context: String(formData.get("context") ?? "").trim() || null,
        minutes: Number(formData.get("minutes")) || 6,
      });
    } catch (e) {
      const message =
        e instanceof AiRuntimeError ? e.message : "The draft could not be generated";
      redirect(`/tenants/${tenantId}/training-admin?error=${encodeURIComponent(message)}`);
    }

    const client = await requestClient();
    const { data: module, error: moduleError } = await client
      .from("training_module")
      .insert({
        tenant_id: tenantId,
        title: draft.title,
        body: draft.body,
        estimated_minutes: draft.estimatedMinutes,
        source: "ai_generated",
        model_name: draft.model,
        prompt_key: draft.promptKey,
        created_by: current.session.personId,
      })
      .select("id")
      .single();
    if (moduleError) throw new Error("The draft could not be saved");

    const { data: questions, error: questionError } = await client
      .from("training_question")
      .insert(
        draft.questions.map((question, index) => ({
          tenant_id: tenantId,
          module_id: module!.id,
          position: index + 1,
          question: question.question,
          options: question.options,
        }))
      )
      .select("id, position");
    if (questionError) throw new Error("The questions could not be saved");

    await client.from("training_answer_key").insert(
      (questions ?? []).map((row) => ({
        question_id: row.id,
        tenant_id: tenantId,
        correct_index: draft.questions[(row.position as number) - 1]!.correctIndex,
        explanation: draft.questions[(row.position as number) - 1]!.explanation,
      }))
    );

    revalidatePath(`/tenants/${tenantId}/training-admin`);
  }

  async function publishModule(formData: FormData) {
    "use server";
    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    const client = await requestClient();
    const { error } = await client.rpc("publish_training_module", {
      p_caller_person_id: current.session.personId,
      p_module_id: String(formData.get("moduleId") ?? ""),
    });
    if (error) {
      redirect(`/tenants/${tenantId}/training-admin?error=${encodeURIComponent(error.message)}`);
    }
    revalidatePath(`/tenants/${tenantId}/training-admin`);
  }

  async function sendToEveryone(formData: FormData) {
    "use server";
    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    const client = await requestClient();
    const { data, error } = await client.rpc("assign_training_to_everyone", {
      p_caller_person_id: current.session.personId,
      p_tenant_id: tenantId,
      p_module_id: String(formData.get("moduleId") ?? ""),
    });
    if (error) {
      redirect(`/tenants/${tenantId}/training-admin?error=${encodeURIComponent(error.message)}`);
    }
    redirect(`/tenants/${tenantId}/training-admin?sent=${data ?? 0}`);
  }

  const modules = (moduleRows ?? []) as unknown as ModuleRow[];
  const attempts = (attemptRows ?? []) as unknown as AttemptRow[];
  const members = (memberRows ?? []) as unknown as MemberRow[];
  const drafts = modules.filter((m) => !m.published);
  const live = modules.filter((m) => m.published);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Training</p>
        <h1 className="mt-1 text-2xl font-semibold">Write it, check it, send it</h1>
        <p className="mt-1 text-sm text-slate-600">
          {access.membership.tenantName} · modules run under 10 minutes and pass at 90%. Below
          that, the whole module is retaken.
        </p>
      </header>

      {formError ? (
        <p className="mt-5 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900" data-testid="training-admin-error">
          {formError}
        </p>
      ) : null}
      {sent ? (
        <p className="mt-5 rounded border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900" data-testid="training-sent">
          {sent === "0"
            ? "Everyone already has this one."
            : `Assigned to ${sent} ${sent === "1" ? "person" : "people"}.`}
        </p>
      ) : null}

      {access.membership.tenantStatus === "active" ? (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Draft a module</h2>
          <p className="mt-1 text-sm text-slate-600">
            It arrives as a draft. Nobody sees it until you publish it, and your name goes on it
            when you do.
          </p>
          <form action={draftModule} className="mt-3 space-y-4" data-testid="draft-form">
            <div>
              <label htmlFor="topic" className="block text-sm font-medium text-slate-800">
                What should it cover?
              </label>
              <input
                id="topic"
                name="topic"
                required
                placeholder="Spotting and reporting a data breach"
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="draft-topic"
              />
            </div>
            <div>
              <label htmlFor="context" className="block text-sm font-medium text-slate-800">
                Anything about this company worth knowing?
              </label>
              <textarea
                id="context"
                name="context"
                rows={2}
                placeholder="A recruitment agency placing contractors in regulated roles."
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="draft-context"
              />
              <p className="mt-1 text-xs text-slate-500">
                Used to make the examples yours rather than generic.
              </p>
            </div>
            <div>
              <label htmlFor="minutes" className="block text-sm font-medium text-slate-800">
                How long, in minutes
              </label>
              <input
                id="minutes"
                name="minutes"
                type="number"
                min={1}
                max={10}
                defaultValue={6}
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
                data-testid="draft-minutes"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
              data-testid="draft-module"
            >
              Draft it
            </button>
          </form>
        </section>
      ) : null}

      {drafts.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Waiting for your review</h2>
          <ul className="mt-3 space-y-4" data-testid="draft-list">
            {drafts.map((module) => (
              <li key={module.id} className="rounded border border-amber-300 bg-amber-50 p-4" data-testid="draft-module-row">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium" data-testid="draft-module-title">{module.title}</p>
                    <p className="text-xs uppercase tracking-wide text-amber-900">
                      {module.source === "ai_generated" ? "Drafted by AI · unreviewed" : "Draft"} ·{" "}
                      {module.estimated_minutes} min · pass {module.pass_mark}%
                    </p>
                  </div>
                  <form action={publishModule}>
                    <input type="hidden" name="moduleId" value={module.id} />
                    <button
                      type="submit"
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                      data-testid="publish-module"
                    >
                      Publish
                    </button>
                  </form>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700" data-testid="draft-module-body">
                  {module.body}
                </p>
                <p className="mt-2 text-xs text-amber-900">
                  Read it before publishing. Your name is recorded against it.
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Published</h2>
        {live.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600" data-testid="no-published-modules">
            Nothing published yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-5" data-testid="published-list">
            {live.map((module) => {
              const mine = attempts.filter((a) => a.module_id === module.id);
              const passedBy = new Set(mine.filter((a) => a.passed).map((a) => a.person_id));
              const triedBy = new Set(mine.map((a) => a.person_id));

              return (
                <li key={module.id} className="rounded border border-slate-200 p-4" data-testid="published-module">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium" data-testid="published-module-title">{module.title}</p>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        {module.estimated_minutes} min · pass {module.pass_mark}%
                      </p>
                    </div>
                    {access.membership.tenantStatus === "active" ? (
                      <form action={sendToEveryone}>
                        <input type="hidden" name="moduleId" value={module.id} />
                        <button
                          type="submit"
                          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800"
                          data-testid="send-to-everyone"
                        >
                          Send to everyone
                        </button>
                      </form>
                    ) : null}
                  </div>

                  <p className="mt-3 text-sm text-slate-700" data-testid="completion-summary">
                    {passedBy.size} of {members.length} passed
                  </p>
                  <ul className="mt-2 space-y-1 text-sm" data-testid="completion-list">
                    {members.map((member) => {
                      const id = member.person?.id ?? "";
                      const name = member.person?.full_name ?? member.person?.email ?? "Unknown";
                      const state = passedBy.has(id)
                        ? "Passed"
                        : triedBy.has(id)
                          ? "Attempted, not passed"
                          : "Not started";
                      return (
                        <li key={id} className="flex justify-between gap-3" data-testid="completion-row" data-state={state}>
                          <span className="text-slate-700">{name}</span>
                          <span
                            className={
                              state === "Passed"
                                ? "text-emerald-800"
                                : state === "Not started"
                                  ? "text-slate-500"
                                  : "text-amber-900"
                            }
                          >
                            {state}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function SignInPrompt() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Fractional DPO</h1>
      <p className="mt-4">
        <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
