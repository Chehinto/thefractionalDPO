/**
 * The two pages a tier-3 link can open (design resume §4).
 *
 * One route, because a link holder should not have to know which kind of link
 * they were sent — the token decides, and the purpose recorded against it
 * decides which door opens. A questionnaire link reaching the register view, or
 * the reverse, is refused by the database as if the token were unknown.
 *
 * The only page in this product served to someone with no account, no session
 * and no membership. Everything it can reach goes through the three definer
 * functions in 0013 — it never queries a table — so the database, not this
 * file, decides what a token is worth. If every line here were wrong, a token
 * would still reach nothing but its own questionnaire.
 *
 * The token is in the path, which is inherent to a share link: it will appear
 * in server access logs. That is what the expiry ceiling, revocation and the
 * view log are for. It is never written anywhere else, and never stored.
 *
 * `notFound()` answers an unknown token, an expired one, a revoked one, a
 * malformed one, and a link for a purpose this page does not serve. A stranger
 * cannot tell those apart, which is what stops the URL being an oracle for
 * whether a given workspace exists.
 */

import { notFound, redirect } from "next/navigation";
import { hashScopedAccessToken, scopedAccessTokenFromParam } from "@/lib/scoped-access";
import { anonClient } from "@/lib/supabase-server";
import { RegisterView, type RegisterRow } from "./register-view";

export const dynamic = "force-dynamic";

interface QuestionRow {
  question_id: string;
  question_position: number;
  question: string;
  answer_type: "free_text" | "yes_no" | "document_upload";
  why_needed: string;
  existing_answer: string | null;
}

interface GrantSummary {
  purpose: string;
  label: string;
  tenant_name: string;
  expires_at: string;
}

export default async function ScopedQuestionnairePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ answered?: string }>;
}) {
  const { token: raw } = await params;
  const { answered } = await searchParams;

  const token = scopedAccessTokenFromParam(raw);
  if (!token) notFound();

  const tokenHash = hashScopedAccessToken(token);
  const supabase = anonClient();

  const { data: redeemed } = await supabase.rpc("redeem_scoped_access", {
    p_token_hash: tokenHash,
  });
  const grant = (redeemed ?? [])[0] as GrantSummary | undefined;
  if (!grant) notFound();

  if (grant.purpose === "auditor_review") {
    const { data: registerRows } = await supabase.rpc("scoped_register", {
      p_token_hash: tokenHash,
    });
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <header className="border-b border-slate-200 pb-5">
          <p className="text-xs uppercase tracking-widest text-slate-500">Record of processing</p>
          <h1 className="mt-1 text-2xl font-semibold" data-testid="scoped-heading">
            {grant.tenant_name}
          </h1>
          <p className="mt-2 text-sm text-slate-600" data-testid="scoped-intro">
            Their Article 30 register, as approved by their Data Protection Officer. Draft entries
            are not shown — an activity appears here once it has been approved.
          </p>
          <p className="mt-2 text-xs text-slate-500" data-testid="scoped-expiry">
            This link stops working on {formatDate(grant.expires_at)}.
          </p>
        </header>
        <RegisterView
          tenantName={grant.tenant_name}
          rows={(registerRows ?? []) as unknown as RegisterRow[]}
        />
      </main>
    );
  }

  // Any purpose this page does not serve is answered as an unknown token.
  if (grant.purpose !== "vendor_questionnaire") notFound();

  const { data: questionRows } = await supabase.rpc("scoped_questionnaire", {
    p_token_hash: tokenHash,
  });
  const questions = (questionRows ?? []) as unknown as QuestionRow[];

  async function submitAnswer(formData: FormData) {
    "use server";

    // Re-derived from the path rather than carried in a hidden field, so a
    // posted form cannot name a different link than the page was opened with.
    const actionToken = scopedAccessTokenFromParam(raw);
    if (!actionToken) notFound();

    const client = anonClient();
    const { data, error } = await client.rpc("submit_scoped_questionnaire_response", {
      p_token_hash: hashScopedAccessToken(actionToken),
      p_question_id: String(formData.get("questionId") ?? ""),
      p_answer: String(formData.get("answer") ?? ""),
      p_evidence: null,
      p_respondent_email: String(formData.get("respondentEmail") ?? "") || null,
    });

    // A null id means the link stopped working between opening the page and
    // answering — revoked, expired, or the workspace suspended.
    if (error || !data) notFound();

    redirect(`/s/${actionToken}?answered=1`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Vendor questionnaire</p>
        <h1 className="mt-1 text-2xl font-semibold" data-testid="scoped-heading">
          {grant.tenant_name} has some questions
        </h1>
        <p className="mt-2 text-sm text-slate-600" data-testid="scoped-intro">
          They are reviewing what personal data you process on their behalf. Answer what you can —
          your answers go to their Data Protection Officer for review, and nothing is published.
        </p>
        <p className="mt-2 text-xs text-slate-500" data-testid="scoped-expiry">
          This link stops working on {formatDate(grant.expires_at)}.
        </p>
      </header>

      {answered === "1" ? (
        <div
          className="mt-5 rounded border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          data-testid="answer-saved"
        >
          Saved. You can change an answer by submitting it again.
        </div>
      ) : null}

      {questions.length === 0 ? (
        <p className="py-10 text-sm text-slate-600" data-testid="scoped-empty">
          There are no questions on this questionnaire yet.
        </p>
      ) : (
        <ol className="mt-6 space-y-8" data-testid="scoped-question-list">
          {questions.map((question) => (
            <li key={question.question_id} data-testid="scoped-question">
              <p className="text-sm font-medium text-slate-900" data-testid="scoped-question-text">
                {question.question_position}. {question.question}
              </p>
              <p className="mt-1 text-xs text-slate-500" data-testid="scoped-why-needed">
                Why they are asking: {question.why_needed}
              </p>

              <form action={submitAnswer} className="mt-3 space-y-2">
                <input type="hidden" name="questionId" value={question.question_id} />
                <label className="sr-only" htmlFor={`answer-${question.question_id}`}>
                  Your answer
                </label>
                <textarea
                  id={`answer-${question.question_id}`}
                  name="answer"
                  required
                  rows={3}
                  defaultValue={question.existing_answer ?? ""}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  data-testid="scoped-answer-input"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                    data-testid="scoped-answer-submit"
                  >
                    {question.existing_answer ? "Update answer" : "Save answer"}
                  </button>
                  {question.existing_answer ? (
                    <span className="text-xs text-emerald-800" data-testid="scoped-answer-recorded">
                      Answer recorded
                    </span>
                  ) : null}
                </div>
              </form>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
