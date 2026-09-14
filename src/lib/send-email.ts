import "server-only";

import { esc } from "./html-escape";
import { serviceClient } from "./supabase-server";

/**
 * One way out of this product, and the record that it happened.
 *
 * The shape is AxioVendo's, because the reasoning survives the port: an
 * allow-list so a test fixture cannot mail a real person, an idempotency key so
 * a retry cannot send twice, and a return value rather than an exception so a
 * failed notification never fails the work that triggered it.
 *
 * Two things differ here, and both come from §1. This product sends on a DPO's
 * behalf to a company that has no relationship with us, so:
 *
 *   - `platform_send_authorized` is checked by the CALLER, not here. This
 *     function is the transport; the authorization is a fact about a workspace
 *     and belongs where that decision is made, not buried in a mailer where a
 *     future caller could forget it exists.
 *   - Delivery is logged per tenant, so a DPO can see what went out under their
 *     name. That is the point of sending on someone's behalf: they remain
 *     accountable for it, so they have to be able to read it back.
 *
 * Resend over raw fetch, deliberately no SDK: this repo has six dependencies
 * and the API is one POST. The same call the SDK would make.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export type EmailOutcome = "sent" | "skipped_unconfigured" | "skipped_allowlist" | "failed";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  templateKey: string;
  tenantId?: string | null;
  /** Same key twice means the second send does not happen. */
  idempotencyKey?: string | null;
  scopedAccessGrantId?: string | null;
  createdBy?: string | null;
}

export interface SendEmailResult {
  outcome: EmailOutcome;
  providerId: string | null;
}

/**
 * Who we are allowed to email.
 *
 * With EMAIL_ALLOWLIST set, only listed addresses (or anything at a listed
 * @domain) are sent to and everything else is recorded as skipped. Sending real
 * mail to a real person because a seed fixture used their address is worse than
 * not sending at all — and this product's fixtures are full of plausible
 * company addresses.
 */
export function allowedRecipient(to: string, allowlist = process.env.EMAIL_ALLOWLIST): boolean {
  const list = (allowlist ?? "").trim();
  if (!list) return true; // not configured: normal behaviour
  const entries = list
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const address = to.trim().toLowerCase();
  return entries.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry));
}

export function emailLayout(body: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
  ${body}
</div>`;
}

export function emailButton(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">${esc(label)}</a>`;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Fractional DPO <notifications@example.invalid>";

  // Both are recorded rather than silently dropped: "we never sent it" is an
  // answer a DPO may need, and it looks identical to "it bounced" unless the
  // skip is written down.
  if (!apiKey) {
    await record(input, "skipped_unconfigured", null, null);
    return { outcome: "skipped_unconfigured", providerId: null };
  }
  if (!allowedRecipient(input.to)) {
    await record(input, "skipped_allowlist", null, null);
    return { outcome: "skipped_allowlist", providerId: null };
  }

  // Claimed BEFORE the provider call, not after. A row written afterwards would
  // let two concurrent retries both pass the check and both send; the unique
  // index on idempotency_key is what makes "at most once" true rather than
  // likely.
  const claim = await record(input, "sent", null, null);
  if (claim === null) return { outcome: "sent", providerId: null }; // already sent

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    await updateOutcome(claim, "failed", null, "the email provider could not be reached");
    return { outcome: "failed", providerId: null };
  }

  if (!response.ok) {
    await updateOutcome(claim, "failed", null, `provider returned ${response.status}`);
    return { outcome: "failed", providerId: null };
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  const providerId = typeof body?.id === "string" ? body.id : null;
  await updateOutcome(claim, "sent", providerId, null);
  return { outcome: "sent", providerId };
}

/**
 * Write the delivery row, returning its id — or null when this exact message
 * has already been sent, which is the idempotency key doing its job rather than
 * an error.
 */
async function record(
  input: SendEmailInput,
  outcome: EmailOutcome,
  providerId: string | null,
  error: string | null
): Promise<string | null> {
  const { data, error: insertError } = await serviceClient()
    .from("email_log")
    .insert({
      tenant_id: input.tenantId ?? null,
      template_key: input.templateKey,
      recipient: input.to,
      subject: input.subject,
      idempotency_key: input.idempotencyKey ?? null,
      outcome,
      provider_id: providerId,
      error,
      scoped_access_grant_id: input.scopedAccessGrantId ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();

  if (insertError) {
    // 23505 is the idempotency key: this message already went out.
    if (insertError.code === "23505") return null;
    // Never thrown. A delivery record that cannot be written is a problem for
    // whoever reads the log, not a reason to fail a DPO's questionnaire.
    console.error(`[email] could not record delivery: template=${input.templateKey}`);
    return null;
  }

  return data!.id as string;
}

async function updateOutcome(
  id: string,
  outcome: EmailOutcome,
  providerId: string | null,
  error: string | null
) {
  const { error: updateError } = await serviceClient()
    .from("email_log")
    .update({ outcome, provider_id: providerId, error })
    .eq("id", id);

  if (updateError) {
    // Recipient and subject stay out of the platform log on purpose; the
    // template key is enough to find the row in `email_log`.
    console.error(`[email] could not update delivery outcome for ${id}`);
  }
}
