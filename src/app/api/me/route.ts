/**
 * Who the caller is, and every tenant they can currently reach.
 *
 * Takes no tenant id at all — that is the point. The portfolio of §4 is a
 * computed rollup of live memberships, so it is derived from the session and
 * cannot be widened by anything the client sends.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/tenant-access";

// Never cached. A response cached for even a few seconds would keep answering
// with a membership list that revocation has already invalidated, and §4 gives
// revocation no grace period.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    return NextResponse.json({
      personId: session.personId,
      email: session.email,
      memberships: session.memberships,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
