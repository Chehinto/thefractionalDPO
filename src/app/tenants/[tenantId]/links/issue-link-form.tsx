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
          questionnaireId: form.get("questionnaireId"),
          days: Number(form.get("days")),
        }),
      });
      const body = (await response.json()) as { url?: string; expiresAt?: string; error?: string };

      if (!response.ok || !body.url) {
        setError(body.error ?? "The link could not be issued");
        return;
      }
      setIssued({
        url: body.url,
        label: String(form.get("label") ?? ""),
        expiresAt: body.expiresAt ?? "",
      });
    } catch {
      setError("The link could not be issued");
    } finally {
      setBusy(false);
    }
  }

  if (questionnaires.length === 0) {
    return (
      <p className="mt-3 text-sm text-slate-600" data-testid="no-sendable-questionnaires">
        No approved questionnaires yet. A questionnaire has to be approved before it can be sent —
        otherwise a vendor would be answering wording the DPO has not signed off.
      </p>
    );
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="mt-3 space-y-4" data-testid="issue-link-form">
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
          disabled={busy}
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
