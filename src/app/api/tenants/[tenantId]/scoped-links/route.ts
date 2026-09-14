/**
 * Issue one tier-3 link.
 *
 * This is a route handler rather than a server action for one reason: the
 * plaintext token exists exactly once, in this response body, and a server
 * action on React 18 has no way to hand a value back to the page without
 * putting it through a redirect — which would write the token into the DPO's
 * browser history and into every access log between here and them.
 *
 * The token is generated and hashed here; only the hash reaches Postgres.
 */

import { NextResponse } from "next/server";
import {
  createScopedAccessToken,
  MAX_SCOPED_ACCESS_DAYS,
  scopedAccessExpiry,
} from "@/lib/scoped-access";
import { errorResponse, requireMembership, TenantAccessError } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/send-email";
import {
  vendorQuestionnaireBody,
  vendorQuestionnaireSubject,
} from "@/lib/vendor-questionnaire-email";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const access = await requireMembership(tenantId, { tier: "active_dpo" });

    if (access.membership.tenantStatus !== "active") {
      return NextResponse.json(
        { error: "This workspace is read-only or suspended, so links cannot be issued" },
        { status: 409 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const purpose = body.purpose === "auditor_review" ? "auditor_review" : "vendor_questionnaire";
    const questionnaireId = typeof body.questionnaireId === "string" ? body.questionnaireId : "";
    const days = Number(body.days);
    const vendorContactEmail =
      typeof body.vendorContactEmail === "string" ? body.vendorContactEmail.trim() : "";

    if (!label) {
      return NextResponse.json({ error: "Say who this link is for" }, { status: 400 });
    }
    // The schema enforces this pairing too — a questionnaire grant names its
    // questionnaire and an auditor grant must not, so a read link can never be
    // pointed at a write path. Checked here as well so the answer is a sentence
    // rather than a constraint violation.
    if (purpose === "vendor_questionnaire" && !questionnaireId) {
      return NextResponse.json({ error: "Choose a questionnaire to send" }, { status: 400 });
    }
    if (!Number.isFinite(days) || days < 1 || days > MAX_SCOPED_ACCESS_DAYS) {
      return NextResponse.json(
        { error: `Choose between 1 and ${MAX_SCOPED_ACCESS_DAYS} days` },
        { status: 400 }
      );
    }

    const { token, tokenHash } = createScopedAccessToken();
    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("issue_scoped_access", {
      p_caller_person_id: access.session.personId,
      p_tenant_id: tenantId,
      p_purpose: purpose,
      p_token_hash: tokenHash,
      p_label: label,
      p_expires_at: scopedAccessExpiry(days),
      p_vendor_questionnaire_id: purpose === "vendor_questionnaire" ? questionnaireId : null,
    });

    if (error) {
      // The function answers a questionnaire that is not this tenant's, or not
      // approved, the same way it answers a caller who is not the DPO here.
      return NextResponse.json({ error: messageFor(error.message) }, { status: statusFor(error.message) });
    }

    const grant = data as { id: string; expires_at: string };
    const url = new URL(`/s/${token}`, request.url).toString();
    const delivery = await maybeSend({
      supabase,
      tenantId,
      grant,
      url,
      purpose,
      questionnaireId,
      vendorContactEmail,
      session: access.session,
    });

    return NextResponse.json(
      {
        // Returned once and never recoverable. Nothing stores the plaintext.
        // Still returned even when the message was sent, because "sent" is not
        // "arrived" — a DPO who gets a bounce needs the link in their hand.
        url,
        grantId: grant.id,
        expiresAt: grant.expires_at,
        label,
        delivery,
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof TenantAccessError) return errorResponse(e);
    throw e;
  }
}

function statusFor(message: string): number {
  if (message.includes("not found")) return 404;
  if (message.includes("not approved")) return 409;
  if (message.includes("read-only")) return 409;
  return 400;
}

function messageFor(message: string): string {
  if (message.includes("not found")) return "Not found";
  if (message.includes("not approved")) {
    return "That questionnaire has not been approved yet, so it cannot be sent";
  }
  if (message.includes("read-only")) return "This workspace cannot be written to";
  return "The link could not be issued";
}

/**
 * Send the link, if this workspace has authorized us to and an address was
 * given. Returns what happened, so the DPO is told rather than left guessing.
 *
 * `platform_send_authorized` is read here, at the point the decision is made,
 * rather than inside the mailer. A mailer that enforced it would be a mailer a
 * future caller could route around by not using it; a caller that has to ask
 * the question cannot forget the question exists.
 */
async function maybeSend({
  supabase,
  tenantId,
  grant,
  url,
  purpose,
  questionnaireId,
  vendorContactEmail,
  session,
}: {
  supabase: Awaited<ReturnType<typeof requestClient>>;
  tenantId: string;
  grant: { id: string; expires_at: string };
  url: string;
  purpose: string;
  questionnaireId: string;
  vendorContactEmail: string;
  session: { personId: string; email: string };
}): Promise<{ attempted: boolean; outcome: string | null; reason: string | null }> {
  if (!vendorContactEmail) {
    return { attempted: false, outcome: null, reason: null };
  }
  if (purpose !== "vendor_questionnaire") {
    return { attempted: false, outcome: null, reason: "Only questionnaire links are sent by email" };
  }

  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, platform_send_authorized, vendor_recommendation_note")
    .eq("id", tenantId)
    .single();

  if (!tenant?.platform_send_authorized) {
    return {
      attempted: false,
      outcome: null,
      reason:
        "This workspace has not authorized us to send on your behalf. Turn that on in Settings, or copy the link and send it yourself.",
    };
  }

  const [{ data: questionnaire }, { count }, { data: person }] = await Promise.all([
    supabase.from("vendor_questionnaire").select("vendor_name").eq("id", questionnaireId).single(),
    supabase
      .from("vendor_questionnaire_question")
      .select("id", { count: "exact", head: true })
      .eq("questionnaire_id", questionnaireId),
    supabase.from("people").select("full_name, email").eq("id", session.personId).single(),
  ]);

  const input = {
    vendorContactEmail,
    vendorName: (questionnaire?.vendor_name as string) ?? "your company",
    tenantName: (tenant.name as string) ?? "a client",
    dpoName: (person?.full_name as string) || (person?.email as string) || session.email,
    linkUrl: url,
    expiresAt: grant.expires_at,
    questionCount: count ?? 0,
    includeRecommendation: Boolean(tenant.vendor_recommendation_note),
  };

  const result = await sendEmail({
    to: vendorContactEmail,
    subject: vendorQuestionnaireSubject(input),
    html: vendorQuestionnaireBody(input),
    templateKey: "vendor_questionnaire_invite",
    tenantId,
    // One send per grant. A double-submitted form issues a second grant with
    // its own key, so this does not block a deliberate re-send; it blocks the
    // same link going out twice.
    idempotencyKey: `vendor_questionnaire_invite:${grant.id}`,
    scopedAccessGrantId: grant.id,
    createdBy: session.personId,
  });

  return { attempted: true, outcome: result.outcome, reason: null };
}
