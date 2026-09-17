/**
 * Workspace settings (design resume §1, growth mechanic 3).
 *
 * Two toggles, rendered as two independent forms. §1 requires that they are
 * never bundled, and the schema keeps them apart — but a single form with one
 * save button would re-bundle them at the surface, which is where a DPO
 * actually experiences the choice. So each saves on its own.
 *
 * The recommendation note is also the reason this page exists at all: §1 says
 * it is disclosed at onboarding and turned off in one click, never asked
 * per-send. "One click" has to lead somewhere.
 */

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { tenantId } = await params;
  const { saved } = await searchParams;

  let access;
  try {
    access = await requireMembership(tenantId, { tier: "active_dpo" });
  } catch (e) {
    if (!(e instanceof TenantAccessError)) throw e;
    if (e.status === 401) return <SignInPrompt />;
    notFound();
  }

  const supabase = await requestClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("platform_send_authorized, vendor_recommendation_note")
    .eq("id", tenantId)
    .single();

  async function setSendAuthorization(formData: FormData) {
    "use server";
    await update(tenantId, {
      platform_send_authorized: formData.get("value") === "on",
    });
  }

  async function setRecommendationNote(formData: FormData) {
    "use server";
    await update(tenantId, {
      vendor_recommendation_note: formData.get("value") === "on",
    });
  }

  const sendAuthorized = Boolean(data?.platform_send_authorized);
  const recommendationOn = Boolean(data?.vendor_recommendation_note);
  const readOnly = access.membership.tenantStatus !== "active";

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="border-b border-slate-200 pb-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold">{access.membership.tenantName}</h1>
      </header>

      {saved === "1" ? (
        <p
          className="mt-5 rounded border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900"
          data-testid="settings-saved"
        >
          Saved.
        </p>
      ) : null}

      {error ? (
        <div
          className="mt-6 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
          data-testid="settings-error"
        >
          <strong>Settings could not be loaded.</strong>
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          <Toggle
            testId="setting-send-authorization"
            title="Send questionnaires on my behalf"
            on={sendAuthorized}
            readOnly={readOnly}
            action={setSendAuthorization}
            description="We email the vendor the questionnaire link, saying plainly that it is sent on your behalf. Off means you copy the link and send it yourself."
            note="Off by default. This authorises us to act in your name, so it is never assumed."
          />

          <Toggle
            testId="setting-recommendation-note"
            title="Include a note recommending AxioVendo"
            on={recommendationOn}
            readOnly={readOnly}
            action={setRecommendationNote}
            description="Vendors who answer questionnaires often can keep their answers in one place. The note is written as your suggestion, says it is optional, and is separate from the questions themselves."
            note="On by default, decided once here rather than asked on every send. Turning it off changes nothing else about the message."
          />
        </div>
      )}
    </main>
  );
}

/**
 * Each toggle is its own form and its own server action. Submitting one never
 * carries the other's value, which is the §1 "never bundled" rule expressed
 * where a person can actually see it.
 */
function Toggle({
  testId,
  title,
  description,
  note,
  on,
  readOnly,
  action,
}: {
  testId: string;
  title: string;
  description: string;
  note: string;
  on: boolean;
  readOnly: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section data-testid={testId} data-on={on ? "true" : "false"}>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
      <form action={action} className="mt-3 flex items-center gap-3">
        <input type="hidden" name="value" value={on ? "off" : "on"} />
        <span
          className={`rounded border px-2 py-0.5 text-xs uppercase tracking-wide ${
            on
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-slate-300 bg-slate-100 text-slate-600"
          }`}
          data-testid={`${testId}-state`}
        >
          {on ? "On" : "Off"}
        </span>
        <button
          type="submit"
          disabled={readOnly}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 disabled:opacity-50"
          data-testid={`${testId}-toggle`}
        >
          {on ? "Turn off" : "Turn on"}
        </button>
      </form>
    </section>
  );
}

async function update(tenantId: string, patch: Record<string, boolean>) {
  "use server";
  const { redirect } = await import("next/navigation");
  const current = await requireMembership(tenantId, { tier: "active_dpo" });
  if (current.membership.tenantStatus !== "active") {
    throw new Error("This workspace is read-only, so settings cannot be changed");
  }

  const client = await requestClient();
  const { error } = await client.from("tenants").update(patch).eq("id", tenantId);
  if (error) throw new Error("That setting could not be saved");

  revalidatePath(`/tenants/${tenantId}/settings`);
  redirect(`/tenants/${tenantId}/settings?saved=1`);
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
