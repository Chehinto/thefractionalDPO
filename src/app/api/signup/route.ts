/**
 * Entry point 2 — brand-new signup.
 *
 * The ordering the flow requires is: auth account, then person row, then
 * workspace. Only the third step happens here.
 *
 * The second step is not a line in this route on purpose. `app.handle_new_auth_user`
 * runs as a trigger on auth.users, so the person row — including claiming an
 * unclaimed roster row with the same email, rather than creating a duplicate —
 * is already resolved by the time any request reaches this handler. Putting it
 * here instead would mean every future way of creating an account (admin API,
 * OAuth, magic link) had to remember to do it.
 *
 * So by the time we get here, `requireSession` either resolves a person or the
 * request is refused. There is no branch in which this route creates identity.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { LEGAL_BASES, type LegalBasis } from "@/lib/legal-basis";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => ({}));
    const name = typeof body.tenantName === "string" ? body.tenantName.trim() : "";
    const legalBasis = body.legalBasis as LegalBasis;

    if (!name) {
      return NextResponse.json({ error: "A workspace name is required" }, { status: 400 });
    }
    if (!LEGAL_BASES.includes(legalBasis)) {
      return NextResponse.json(
        { error: "Tell us why this company has a DPO: mandatory, contractual or voluntary" },
        { status: 400 }
      );
    }

    // signup_first_tenant, not create_tenant: it adds "at most one workspace
    // per new signup" under a lock, then delegates the actual creation to
    // create_tenant. A double-submitted form returns the workspace that already
    // exists instead of making a second identical one.
    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("signup_first_tenant", {
      p_caller_person_id: session.personId,
      p_tenant_name: name,
      p_legal_basis: legalBasis,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({ tenant: data }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
