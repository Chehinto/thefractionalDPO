/**
 * Creating a workspace.
 *
 * §1's growth mechanic is self-serve: anyone who has used the tool can spin up
 * a tenant for another company and is listed as its first Active DPO. The
 * founding member is taken from the session inside `create_tenant`, never from
 * the request body, so this endpoint cannot be used to enrol somebody else.
 */

import { NextResponse } from "next/server";
import { errorResponse, requireSession } from "@/lib/tenant-access";
import { requestClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireSession();

    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "A workspace name is required" }, { status: 400 });
    }

    const supabase = await requestClient();
    const { data, error } = await supabase.rpc("create_tenant", { p_name: name });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({ tenant: data }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
