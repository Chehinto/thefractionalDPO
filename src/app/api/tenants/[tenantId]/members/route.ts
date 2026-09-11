/**
 * The roster of one workspace: who is listed, and adding someone to it.
 *
 * Both operations require the Active DPO tier. A staff member asking for the
 * roster gets 404, not 403 — §4 says staff never see other members, and a 403
 * would still confirm that a roster exists behind the door.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireMembership, type MembershipTier } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const TIERS: MembershipTier[] = ["active_dpo", "staff", "external_scoped"];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    await requireMembership(tenantId, { tier: "active_dpo" });

    const supabase = await requestClient();
    const { data, error } = await supabase
      .from("memberships")
      .select("id, tier, active_from, active_to, person:people(id, email, full_name)")
      .eq("tenant_id", tenantId)
      .order("active_from");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ members: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  try {
    const { tenantId } = await params;
    await requireMembership(tenantId, { tier: "active_dpo" });

    const body = await request.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const tier = body.tier as MembershipTier;

    if (!email) return NextResponse.json({ error: "An email address is required" }, { status: 400 });
    if (!TIERS.includes(tier)) {
      return NextResponse.json({ error: "Unknown membership tier" }, { status: 400 });
    }

    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("add_member", {
      p_tenant_id: tenantId,
      p_email: email,
      p_tier: tier,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: statusFor(error.code) });

    return NextResponse.json({ membership: data }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Postgres raises these; the mapping is here rather than in the database so the
 * SQL stays about correctness and the route stays about HTTP.
 *
 * P0002 is `add_member`'s deliberate "not found" for a tenant the caller does
 * not administer, and it must stay a 404 for the same reason the GET does.
 */
function statusFor(code: string | undefined): number {
  if (code === "P0002") return 404;
  if (code === "23P01") return 409; // exclusion violation: already a live member
  if (code === "42501") return 409; // read-only tenant (§5), not an auth failure
  return 400;
}
