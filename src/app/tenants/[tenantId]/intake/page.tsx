/**
 * Day-to-day intake for operational changes.
 *
 * This is deliberately a note-taking surface, not a register editor. The AI
 * output lands as an `ai_suggestion` with source text and confidence scoring;
 * the DPO still has to review it before anything becomes a register row.
 */

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import {
  AiRuntimeError,
  generateAiSuggestionDraft,
} from "@/lib/ai-suggestion-runtime";
import {
  buildDayToDayIntakeSuggestionRequest,
  parseDayToDayIntakeRequest,
} from "@/lib/day-to-day-intake";
import {
  messageForAiSuggestionSaveError,
  saveAiSuggestion,
} from "@/lib/save-ai-suggestion";

export const dynamic = "force-dynamic";

export default async function IntakePage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  async function createIntake(formData: FormData) {
    "use server";

    const current = await requireMembership(tenantId, { tier: "active_dpo" });
    if (current.membership.tenantStatus !== "active") {
      throw new Error("This workspace is read-only or suspended, so intake drafts cannot be created");
    }

    const intake = parseDayToDayIntakeRequest({
      note: formData.get("note"),
      sourceLabel: formData.get("sourceLabel"),
    });
    const input = buildDayToDayIntakeSuggestionRequest(intake);
    const draft = await generateAiSuggestionDraft(input);
    const { error } = await saveAiSuggestion({
      tenantId,
      personId: current.session.personId,
      input,
      draft,
    });

    if (error) throw new Error(messageForAiSuggestionSaveError(error.code));
    redirect(`/tenants/${tenantId}?filter=you`);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href={`/tenants/${tenantId}`}
        className="text-sm text-slate-600 hover:underline"
        data-testid="back-to-workspace"
      >
        ← Workspace
      </Link>

      <header className="mt-3 border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Intake</p>
        <h1 className="mt-1 text-2xl font-semibold">Capture a change</h1>
        <p className="mt-1 text-sm text-slate-600">
          {access.membership.tenantName}
        </p>
      </header>

      <form action={createIntake} className="mt-6 space-y-5" data-testid="intake-form">
        <div>
          <label htmlFor="sourceLabel" className="block text-sm font-medium text-slate-800">
            Source label
          </label>
          <input
            id="sourceLabel"
            name="sourceLabel"
            defaultValue="Day-to-day intake note"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="note" className="block text-sm font-medium text-slate-800">
            What changed?
          </label>
          <textarea
            id="note"
            name="note"
            required
            rows={9}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            placeholder="Example: We are starting to use ScreenCo for criminal record checks during regulated-role recruitment. HR will upload candidate identity details and the result is kept for 30 days."
          />
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
          <Link
            href={`/tenants/${tenantId}`}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
            data-testid="create-intake"
          >
            Create review draft
          </button>
        </div>
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
