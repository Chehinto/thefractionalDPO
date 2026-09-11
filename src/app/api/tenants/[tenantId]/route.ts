/**
 * One workspace.
 *
 * The tenant-isolation regression case in miniature: the id arrives from the
 * URL, `requireMembership` matches it against the session's own live
 * memberships, and a tenant the caller has no membership in is answered 404 —
 * identically to one that does not exist.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireMembership } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    const { membership } = await requireMembership(tenantId);

    // Read through the caller's own client so RLS applies to this query too.
    // If the membership check above were wrong, the policy would still return
    // nothing — the two layers have to fail together to leak a row.
    const supabase = await requestClient();
    const { data: tenant } = await supabase
      .from("tenants")
      .select("id, name, status, created_at")
      .eq("id", tenantId)
      .maybeSingle();

    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json({ tenant, yourTier: membership.tier });
  } catch (e) {
    return errorResponse(e);
  }
}
