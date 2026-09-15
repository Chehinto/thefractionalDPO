/**
 * Training, for the person taking it (design resume §2.5).
 *
 * §3's gap was that the competitor records who was trained without providing
 * training. So this shows the module body, asks the questions, and records the
 * attempt — the attendance record falls out of that rather than being the
 * product.
 *
 * Open to any member, like `my-tasks`: tier 2 is the audience.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

interface ModuleRow {
  id: string;
  title: string;
  body: string;
  pass_mark: number;
}

interface QuestionRow {
  id: string;
  module_id: string;
  position: number;
  question: string;
  options: string[];
}

interface AttemptRow {
  module_id: string;
  score: number;
  passed: boolean;
  completed_at: string;
}

export default async function TrainingPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ module?: string; error?: string }>;
}) {
  const { tenantId } = await params;
  const { module: openModule, error: formError } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId);
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const [{ data: moduleRows }, { data: questionRows }, { data: attemptRows }] = await Promise.all([
    // RLS shows a member only published modules; drafts stay the DPO's.
    supabase.from("training_module").select("id, title, body, pass_mark").eq("tenant_id", tenantId),
    supabase
      .from("training_question")
      .select("id, module_id, position, question, options")
      .eq("tenant_id", tenantId)
      .order("position"),
    supabase
      .from("training_attempt")
      .select("module_id, score, passed, completed_at")
      .eq("tenant_id", tenantId)
      .eq("person_id", access.session.personId)
      .order("completed_at", { ascending: false }),
  ]);

  async function submitAttempt(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId);
    const moduleId = String(formData.get("moduleId") ?? "");
    const count = Number(formData.get("questionCount") ?? 0);

    // Positions are 1-based in the table; the array the function grades is
    // indexed the same way, so an unanswered question has to be a real gap
    // rather than a silent zero — zero is a valid option index.
    const answers: number[] = [];
    for (let position = 1; position <= count; position += 1) {
      const raw = formData.get(`answer-${position}`);
      if (raw === null) {
        redirect(
          `/tenants/${tenantId}/training?module=${moduleId}&error=${encodeURIComponent("Answer every question before submitting.")}`
        );
      }
      answers.push(Number(raw));
    }

    const client = await requestClient();
    const { error } = await client.rpc("submit_training_attempt", {
      p_caller_person_id: current.session.personId,
      p_module_id: moduleId,
      p_answers: answers,
    });
    if (error) throw new Error("That attempt could not be recorded");

    revalidatePath(`/tenants/${tenantId}/training`);
    redirect(`/tenants/${tenantId}/training?module=${moduleId}`);
  }

  const modules = (moduleRows ?? []) as unknown as ModuleRow[];
  const questions = (questionRows ?? []) as unknown as QuestionRow[];
  const attempts = (attemptRows ?? []) as unknown as AttemptRow[];
  const best = new Map<string, AttemptRow>();
  for (const attempt of attempts) {
    const existing = best.get(attempt.module_id);
    if (!existing || attempt.score > existing.score) best.set(attempt.module_id, attempt);
  }

  const active = modules.find((m) => m.id === openModule) ?? null;
  const activeQuestions = active ? questions.filter((q) => q.module_id === active.id) : [];

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/tasks" className="text-sm text-slate-600 hover:underline" data-testid="back-to-tasks">
        ← Your tasks
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Training</p>
        <h1 className="mt-1 text-2xl font-semibold">{access.membership.tenantName}</h1>
      </header>

      {formError ? (
        <p
          className="mt-5 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900"
          data-testid="training-error"
        >
          {formError}
        </p>
      ) : null}

      {active ? (
        <article className="mt-6" data-testid="training-module">
          <h2 className="text-lg font-semibold" data-testid="training-module-title">
            {active.title}
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700" data-testid="training-body">
            {active.body}
          </p>

          {best.has(active.id) ? (
            <p
              className={`mt-4 rounded border px-3 py-2 text-sm ${
                best.get(active.id)!.passed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-amber-300 bg-amber-50 text-amber-900"
              }`}
              data-testid="training-result"
            >
              Your best score: {best.get(active.id)!.score}%{" "}
              {best.get(active.id)!.passed
                ? "— passed."
                : `— the pass mark is ${active.pass_mark}%. Read it again and retake it.`}
            </p>
          ) : null}

          <form action={submitAttempt} className="mt-6 space-y-6" data-testid="training-form">
            <input type="hidden" name="moduleId" value={active.id} />
            <input type="hidden" name="questionCount" value={activeQuestions.length} />

            {activeQuestions.map((question) => (
              <fieldset key={question.id} data-testid="training-question">
                <legend className="text-sm font-medium text-slate-900">
                  {question.position}. {question.question}
                </legend>
                <div className="mt-2 space-y-1">
                  {question.options.map((option, index) => (
                    <label key={option} className="flex items-start gap-2 text-sm text-slate-700">
                      <input
                        type="radio"
                        name={`answer-${question.position}`}
                        value={index}
                        className="mt-1"
                        data-testid={`answer-${question.position}-${index}`}
                      />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}

            <button
              type="submit"
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white"
              data-testid="submit-training"
            >
              Submit answers
            </button>
          </form>
        </article>
      ) : modules.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="training-empty">
          No training has been published in this workspace yet.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-slate-200" data-testid="training-list">
          {modules.map((module) => {
            const attempt = best.get(module.id);
            return (
              <li
                key={module.id}
                className="flex flex-wrap items-center justify-between gap-2 py-4"
                data-testid="training-module-row"
              >
                <div>
                  <p className="font-medium">{module.title}</p>
                  <p className="text-sm text-slate-600" data-testid="training-module-state">
                    {!attempt
                      ? "Not started"
                      : attempt.passed
                        ? `Passed — ${attempt.score}%`
                        : `Not passed yet — ${attempt.score}%`}
                  </p>
                </div>
                <Link
                  href={`/tenants/${tenantId}/training?module=${module.id}`}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  data-testid="open-training-module"
                >
                  {attempt ? "Retake" : "Start"}
                </Link>
              </li>
            );
          })}
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
