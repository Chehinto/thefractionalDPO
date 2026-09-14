/**
 * The signup double-submit race, pinned deterministically.
 *
 * `tenant-creation.test.ts` fires concurrent signups and hopes the damaging
 * interleaving occurs. Measured against the pre-0014 function, that reproduced
 * the bug in roughly one run in six — which is why it read as a flaky test for
 * long enough that 0007 "hardened" the lock without fixing anything. Raising
 * the concurrency makes it WORSE, not better: the connection pool queues the
 * extra requests so their transactions no longer overlap at all.
 *
 * So this file drives the interleaving instead of waiting for it, using two
 * real Postgres connections. It is the only test here that needs them; every
 * other suite goes through PostgREST, which is one transaction per request and
 * therefore cannot express "these two transactions overlapped".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { adminClient, createActor, type Actor } from "../support/tenancy-fixtures";

/**
 * Derived from the API URL so this follows `supabase/config.toml`'s shifted
 * ports rather than assuming the CLI defaults.
 */
const DB_URL =
  process.env.SUPABASE_DB_URL ??
  `postgresql://postgres:postgres@127.0.0.1:${
    Number(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).port) + 1
  }/postgres`;

let winner: Client;
let loser: Client;
let actor: Actor;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  return client;
}

/** Make this connection look like the signed-in caller to `auth.uid()`. */
async function actAs(client: Client, authUserId: string) {
  await client.query(`set local request.jwt.claims = '${JSON.stringify({ sub: authUserId })}'`);
}

beforeAll(async () => {
  winner = await connect();
  loser = await connect();
  actor = await createActor("signup-race");
});

afterAll(async () => {
  await winner.end();
  await loser.end();
});

describe("two signups whose transactions overlap", () => {
  it("gives the second one the workspace the first created, not a second workspace", async () => {
    // 1. The LOSER opens its transaction first, so its now() — frozen at
    //    transaction start — predates everything the winner is about to do.
    //    This is the whole bug: a request that began earlier but finished later.
    await loser.query("begin");
    await actAs(loser, actor.authUserId);
    const { rows: loserClock } = await loser.query("select now() as t");

    // 2. The WINNER then opens its own transaction, takes the lock that
    //    `signup_first_tenant` takes, and creates the workspace. Its membership
    //    is stamped active_from = its own now(), which is LATER than the
    //    loser's.
    await winner.query("begin");
    await actAs(winner, actor.authUserId);
    await winner.query("select 1 from public.people where id = $1 for update", [actor.personId]);
    const { rows: created } = await winner.query(
      "select id from public.create_tenant($1, $2, $3)",
      [actor.personId, "Overlap Ltd", "voluntary"]
    );
    const winnerTenantId = created[0].id as string;

    const { rows: winnerClock } = await winner.query("select now() as t");
    expect(winnerClock[0].t.getTime()).toBeGreaterThan(loserClock[0].t.getTime());

    // 3. The loser now calls signup. It blocks on the winner's row lock, so the
    //    call is issued and only completes once the winner has committed.
    const loserCall = loser.query("select id from public.signup_first_tenant($1, $2, $3)", [
      actor.personId,
      "Overlap Ltd",
      "voluntary",
    ]);

    await new Promise((resolve) => setTimeout(resolve, 250));
    await winner.query("commit");

    const { rows: loserResult } = await loserCall;
    await loser.query("commit");

    // Before 0014 this returned a SECOND workspace: the loser could see the
    // winner's membership, but judged it not-yet-live because active_from was
    // later than its own frozen now().
    expect(loserResult[0].id).toBe(winnerTenantId);

    const { data: memberships } = await adminClient()
      .from("memberships")
      .select("tenant_id")
      .eq("person_id", actor.personId);
    expect(memberships).toHaveLength(1);
  });
});
