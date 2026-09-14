"use client";

/**
 * Issue a link and show it once.
 *
 * A client component on purpose. The plaintext token comes back in the POST
 * response body and is rendered straight into the DOM — it is never a URL the
 * browser navigates to, so it stays out of history and out of every access log
 * on the way. Nothing stores it: if the DPO loses it they revoke and reissue,
 * which is the behaviour the hashed column is there to force.
 */

import { useState } from "react";

// The expiry bounds arrive as props rather than being imported: `scoped-access`
// is `server-only`, and that guard is worth more than the convenience of
// importing two numbers. Re-declaring them here would be the real cost — a
// second copy of a limit the database enforces.

interface Questionnaire {
  id: string;
  vendorName: string;
}

interface Issued {
  url: string;
  label: string;
  expiresAt: string;
  delivery: { attempted: boolean; outcome: string | null; reason: string | null } | null;
}

export function IssueLinkForm({
  tenantId,
  questionnaires,
  defaultDays,
  maxDays,
}: {
  tenantId: string;
  questionnaires: Questionnaire[];
  defaultDays: number;
  maxDays: number;
}) {
  const [purpose, setPurpose] = useState<"vendor_questionnaire" | "auditor_review">(
    "vendor_questionnaire"
  );
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setCopied(false);

    try {
      const response = await fetch(`/api/tenants/${tenantId}/scoped-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: form.get("label"),
          vendorContactEmail: form.get("vendorContactEmail"),
          purpose,
          questionnaireId: form.get("questionnaireId"),
          days: Number(form.get("days")),
        }),
      });
      const body = (await response.json()) as {
        url?: string;
        expiresAt?: string;
        error?: string;
        delivery?: Issued["delivery"];
      };

      if (!response.ok || !body.url) {
        setError(body.error ?? "The link could not be issued");
        return;
      }
      setIssued({
        url: body.url,
        label: String(form.get("label") ?? ""),
        expiresAt: body.expiresAt ?? "",
        delivery: body.delivery ?? null,
      });
    } catch {
      setError("The link could not be issued");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="mt-3 space-y-4" data-testid="issue-link-form">
        <div>
          <label htmlFor="purpose" className="block text-sm font-medium text-slate-800">
            What is this link for?
          </label>
          <select
            id="purpose"
            name="purpose"
            value={purpose}
            onChange={(event) =>
              setPurpose(event.target.value as "vendor_questionnaire" | "auditor_review")
            }
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="link-purpose"
          >
            <option value="vendor_questionnaire">A vendor answering a questionnaire</option>
            <option value="auditor_review">An auditor reading the register</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">
            {purpose === "vendor_questionnaire"
              ? "They see only the questions on that questionnaire, and can answer them."
              : "They see only approved register entries. No drafts, no DPIA, no evidence, no names."}
          </p>
        </div>

        {purpose === "vendor_questionnaire" ? (
          questionnaires.length === 0 ? (
            <p className="text-sm text-slate-600" data-testid="no-sendable-questionnaires">
              No approved questionnaires yet. A questionnaire has to be approved before it can be
              sent — otherwise a vendor would be answering wording the DPO has not signed off.
            </p>
          ) : (
            <div>
              <label htmlFor="questionnaireId" className="block text-sm font-medium text-slate-800">
                Questionnaire
              </label>
              <select
                id="questionnaireId"
                name="questionnaireId"
                required
                className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              >
                {questionnaires.map((questionnaire) => (
                  <option key={questionnaire.id} value={questionnaire.id}>
                    {questionnaire.vendorName}
                  </option>
                ))}
              </select>
            </div>
          )
        ) : null}

        <div>
          <label htmlFor="label" className="block text-sm font-medium text-slate-800">
            Who is it for?
          </label>
          <input
            id="label"
            name="label"
            required
            placeholder="Acme security team"
            data-testid="link-label-input"
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            Recorded against every use of this link, so the log says who was asked.
          </p>
        </div>

        {purpose === "vendor_questionnaire" ? (
          <div>
            <label
              htmlFor="vendorContactEmail"
              className="block text-sm font-medium text-slate-800"
            >
              Vendor email (optional)
            </label>
            <input
              id="vendorContactEmail"
              name="vendorContactEmail"
              type="email"
              placeholder="security@acme.com"
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
              data-testid="vendor-contact-email"
            />
            <p className="mt-1 text-xs text-slate-500">
              Leave blank to copy the link and send it yourself. Filling it in only sends if this
              workspace has authorised us to send on your behalf.
            </p>
          </div>
        ) : null}

        <div>
          <label htmlFor="days" className="block text-sm font-medium text-slate-800">
            Expires after
          </label>
          <input
            id="days"
            name="days"
            type="number"
            min={1}
            max={maxDays}
            defaultValue={defaultDays}
            required
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            Days. At most {maxDays}, enforced by the database.
          </p>
        </div>

        {error ? (
          <p
            className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
            data-testid="issue-link-error"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || (purpose === "vendor_questionnaire" && questionnaires.length === 0)}
          className="w-full rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-60"
          data-testid="issue-link"
        >
          {busy ? "Creating…" : "Create link"}
        </button>
      </form>

      {issued ? (
        <div
          className="mt-5 rounded border border-emerald-300 bg-emerald-50 px-4 py-3"
          data-testid="issued-link"
        >
          <p className="text-sm font-medium text-emerald-900">
            Copy this now — it is shown once and cannot be retrieved.
          </p>
          <p className="mt-1 text-xs text-emerald-800">
            Send it to {issued.label} yourself. Revoke it below at any time.
          </p>
          {issued.delivery?.attempted ? (
            <p className="mt-2 text-xs text-emerald-800" data-testid="issued-link-sent">
              {issued.delivery.outcome === "sent"
                ? "Emailed to the vendor on your behalf."
                : `Not delivered (${issued.delivery.outcome}). Send the link yourself.`}
            </p>
          ) : issued.delivery?.reason ? (
            <p className="mt-2 text-xs text-amber-900" data-testid="issued-link-not-sent">
              {issued.delivery.reason}
            </p>
          ) : null}
          <code
            className="mt-2 block break-all rounded border border-emerald-200 bg-white px-2 py-1.5 text-xs"
            data-testid="issued-link-url"
          >
            {issued.url}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(issued.url).then(
                () => setCopied(true),
                () => setCopied(false)
              );
            }}
            className="mt-2 rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-900"
            data-testid="copy-issued-link"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
