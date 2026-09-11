/**
 * Entry point 1 — an existing Active DPO adding another workspace.
 *
 * §1's growth mechanic: anyone who has used the tool can spin up a tenant for
 * another company and is listed as its first Active DPO. This is the button the
 * portfolio dashboard will eventually call; the dashboard itself is not built
 * yet, so this route is the whole of entry point 1 for now.
 *
 * It does not create anything itself. `create_tenant` holds the guarantee that
 * the creator becomes Active DPO of the new tenant and of nothing else, and
 * both entry points go through it — see 0002_tenant_creation.sql.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";
import { LEGAL_BASES, type LegalBasis } from "@/lib/legal-basis";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // The person id passed to create_tenant comes from here — the session —
    // and never from the request body. The database checks it again against
    // its own view of the session and refuses a mismatch, so a bug in this
    // route cannot create a workspace in someone else's name.
    const session = await requireSession();

    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
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

    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("create_tenant", {
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
