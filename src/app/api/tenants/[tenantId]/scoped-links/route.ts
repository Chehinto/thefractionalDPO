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
    const questionnaireId = typeof body.questionnaireId === "string" ? body.questionnaireId : "";
    const days = Number(body.days);

    if (!label) {
      return NextResponse.json({ error: "Say who this link is for" }, { status: 400 });
    }
    if (!questionnaireId) {
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
      p_purpose: "vendor_questionnaire",
      p_token_hash: tokenHash,
      p_label: label,
      p_expires_at: scopedAccessExpiry(days),
      p_vendor_questionnaire_id: questionnaireId,
    });

    if (error) {
      // The function answers a questionnaire that is not this tenant's, or not
      // approved, the same way it answers a caller who is not the DPO here.
      return NextResponse.json({ error: messageFor(error.message) }, { status: statusFor(error.message) });
    }

    const grant = data as { id: string; expires_at: string };
    return NextResponse.json(
      {
        // Returned once and never recoverable. Nothing stores the plaintext.
        url: new URL(`/s/${token}`, request.url).toString(),
        grantId: grant.id,
        expiresAt: grant.expires_at,
        label,
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
