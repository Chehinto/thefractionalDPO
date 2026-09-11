/**
 * Revoking a membership — §4's "immediate and binary, no grace period".
 *
 * DELETE is the verb because that is what the caller means, but nothing is
 * deleted: `revoke_membership` closes the validity window and leaves the row,
 * because the row is the record that this person held this register for this
 * date range (§5). Removing it would erase both an audit trail and a credential
 * the DPO has earned.
 *
 * The end timestamp is stamped server-side inside the function. A client that
 * could choose it could grant itself the grace period this tier is specified
 * not to have.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ membershipId: string }> }
) {
  try {
    // Establishes 401 for an anonymous caller. Authorisation for this specific
    // membership is decided inside the function, which knows which tenant it
    // belongs to; the route deliberately does not look that up first, because
    // doing so would mean reading a row before checking the right to read it.
    await requireSession();

    const { membershipId } = await params;

    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("revoke_membership", {
      p_membership_id: membershipId,
    });

    if (error) {
      // P0002 covers both "no such membership" and "not in a tenant you
      // administer". They are indistinguishable on purpose.
      if (error.code === "P0002") return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ membership: data });
  } catch (e) {
    return errorResponse(e);
  }
}
