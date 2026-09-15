/**
 * What the incident table refuses to record.
 *
 * Each of these is an Article 33 requirement expressed as a constraint rather
 * than a convention, because a breach is exactly when process gets skipped.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, createActor, createTenant, type Actor } from "../support/tenancy-fixtures";

let dpo: Actor;
let staff: Actor;
let tenantId: string;

const BASE = {
  title: "Mailing list sent to the wrong recipient",
  description: "A CSV of 400 customer addresses went to an external contact.",
  discovered_at: new Date().toISOString(),
};

async function insert(overrides: Record<string, unknown> = {}, actor: Actor = dpo) {
  return actor.client
    .from("incident")
    .insert({ tenant_id: tenantId, ...BASE, ...overrides })
    .select("id")
    .single();
}

beforeAll(async () => {
  dpo = await createActor("incident-dpo");
  staff = await createActor("incident-staff");
  tenantId = await createTenant(dpo, "Incident Co", "mandatory");
  await dpo.client.rpc("add_member", {
    p_tenant_id: tenantId,
    p_email: staff.email,
    p_tier: "staff",
  });
});

describe("the 72-hour clock", () => {
  it("is stamped from discovery, not from when the breach happened", async () => {
    const discovered = new Date("2026-09-10T09:00:00.000Z").toISOString();
    const { data } = await insert({
      occurred_at: new Date("2026-03-01T00:00:00.000Z").toISOString(),
      discovered_at: discovered,
    });

    const { data: row } = await adminClient()
      .from("incident")
      .select("authority_deadline")
      .eq("id", data!.id)
      .single();

    expect(Date.parse(row!.authority_deadline as string)).toBe(
      Date.parse(discovered) + 72 * 3_600_000
    );
  });

  // The deadline is the start of a statutory clock. A record whose deadline can
  // be moved after the fact is not evidence of anything.
  it("cannot be moved by a client, even by rewriting the discovery date", async () => {
    const { data } = await insert();
    const original = await adminClient()
      .from("incident")
      .select("authority_deadline")
      .eq("id", data!.id)
      .single();

    await dpo.client
      .from("incident")
      .update({ discovered_at: new Date("2030-01-01T00:00:00.000Z").toISOString() })
      .eq("id", data!.id);
    await dpo.client
      .from("incident")
      .update({ authority_deadline: new Date("2030-01-01T00:00:00.000Z").toISOString() })
      .eq("id", data!.id);

    const after = await adminClient()
      .from("incident")
      .select("authority_deadline")
      .eq("id", data!.id)
      .single();
    expect(after.data!.authority_deadline).toBe(original.data!.authority_deadline);
  });
});

describe("Art. 33(5): decisions carry their reasoning", () => {
  it("refuses a notifiability decision with no rationale", async () => {
    const { error } = await insert({ notifiability: "not_notifiable" });
    expect(error?.message).toContain("incident_decision_is_reasoned");
  });

  it("accepts one that explains itself", async () => {
    const { error } = await insert({
      notifiability: "not_notifiable",
      notifiability_rationale:
        "Addresses only, sent to a contractor under NDA who confirmed deletion. Unlikely to result in a risk.",
    });
    expect(error).toBeNull();
  });

  it("will not let an unassessed breach be closed", async () => {
    const { data } = await insert();
    const { error } = await dpo.client.rpc("close_incident", {
      p_caller_person_id: dpo.personId,
      p_incident_id: data!.id,
    });
    expect(error?.message).toContain("assess whether this is notifiable");
  });
});

describe("Art. 33(1): a late notification needs its reasons", () => {
  const longAgo = new Date(Date.now() - 200 * 3_600_000).toISOString();

  it("refuses a late notification recorded without them", async () => {
    const { data } = await insert({
      discovered_at: longAgo,
      notifiability: "notifiable_authority",
      notifiability_rationale: "Risk to the individuals is more than unlikely.",
    });

    const { error } = await dpo.client
      .from("incident")
      .update({ notified_authority_at: new Date().toISOString() })
      .eq("id", data!.id);

    expect(error?.message).toContain("incident_late_notification_is_explained");
  });

  it("accepts it when the reasons are recorded alongside", async () => {
    const { data } = await insert({
      discovered_at: longAgo,
      notifiability: "notifiable_authority",
      notifiability_rationale: "Risk to the individuals is more than unlikely.",
    });

    const { error } = await dpo.client
      .from("incident")
      .update({
        notified_authority_at: new Date().toISOString(),
        late_notification_reason:
          "The scope was not established until the third-party forensic report arrived.",
      })
      .eq("id", data!.id);

    expect(error).toBeNull();
  });

  it("does not need them inside the window", async () => {
    const { data } = await insert({
      notifiability: "notifiable_authority",
      notifiability_rationale: "Risk to the individuals is more than unlikely.",
    });
    const { error } = await dpo.client
      .from("incident")
      .update({ notified_authority_at: new Date().toISOString() })
      .eq("id", data!.id);
    expect(error).toBeNull();
  });
});

describe("Art. 34: telling the individuals", () => {
  it("refuses a record of telling them when the assessment did not say to", async () => {
    const { data } = await insert({
      notifiability: "notifiable_authority",
      notifiability_rationale: "Authority only.",
    });
    const { error } = await dpo.client
      .from("incident")
      .update({ notified_subjects_at: new Date().toISOString() })
      .eq("id", data!.id);
    expect(error?.message).toContain("incident_subject_notice_follows_assessment");
  });
});

describe("who can see a breach register", () => {
  // §4 gives tier 2 only what was pushed to them. A breach register is not
  // that; a staff member who needs to help gets an `assignment`.
  it("hides it from staff entirely", async () => {
    await insert();
    const { data } = await staff.client.from("incident").select("id").eq("tenant_id", tenantId);
    expect(data).toEqual([]);

    const { error } = await insert({}, staff);
    expect(error).not.toBeNull();
  });
});
