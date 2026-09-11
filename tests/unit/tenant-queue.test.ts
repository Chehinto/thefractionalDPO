/**
 * The queue rules, in isolation.
 *
 * These could not be tested this way while they lived inside a page file —
 * Next only permits its own exports from one. They moved into
 * `@/lib/tenant-queue` when the single-tenant view became the second caller,
 * and the point of the move is that both screens now answer "what is urgent
 * here" identically. That is what these assert.
 */

import { describe, expect, it } from "vitest";
import {
  applyOwnerFilter,
  byUrgency,
  queueFor,
  taggedFieldsFor,
  type MemberRow,
  type QueueItem,
  type TenantRow,
} from "@/lib/tenant-queue";

const NOW = new Date("2026-09-11T12:00:00Z");
const DAY = 86_400_000;

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: "tenant-a",
    name: "Northwind Retail",
    status: "active",
    legal_basis: "contractual",
    status_changed_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

function member(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    tenant_id: "tenant-a",
    tier: "active_dpo",
    active_from: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    active_to: null,
    person: { id: "p1", email: "dpo@example.test", full_name: "A DPO", auth_user_id: "auth-1" },
    ...overrides,
  };
}

const titles = (items: QueueItem[]) => items.map((i) => i.title);

describe("scoping", () => {
  it("ignores members belonging to another tenant", () => {
    // The single-tenant page queries one tenant, but the portfolio hands the
    // same function every workspace's members at once. Getting this wrong would
    // put one client's people in another client's queue, which is the exact
    // failure this product exists to make impossible.
    const foreignStaff = member({
      tenant_id: "tenant-b",
      tier: "staff",
      person: { id: "p9", email: "elsewhere@example.test", full_name: null, auth_user_id: null },
    });

    const queue = queueFor(tenant(), [member(), foreignStaff], NOW);

    expect(titles(queue)).toEqual(["You are the only Active DPO"]);
    expect(JSON.stringify(queue)).not.toContain("elsewhere@example.test");
  });

  it("counts only this tenant's live members when reporting access", () => {
    const fields = taggedFieldsFor(
      tenant(),
      [member(), member({ tenant_id: "tenant-b" }), member({ tenant_id: "tenant-b" })],
      NOW,
      "A label"
    );
    expect(fields.find((f) => f.label === "People")?.value).toBe("1 with access");
  });

  it("ignores memberships that have already ended", () => {
    const revoked = member({
      tier: "staff",
      active_to: new Date(NOW.getTime() - DAY).toISOString(),
      person: { id: "p2", email: "left@example.test", full_name: null, auth_user_id: null },
    });

    const queue = queueFor(tenant(), [member(), revoked], NOW);
    expect(titles(queue)).not.toContain("A rostered colleague has never signed in");
  });
});

describe("ordering", () => {
  it("puts what runs out first at the top, regardless of area", () => {
    const soon = member({
      tier: "external_scoped",
      active_to: new Date(NOW.getTime() + 3 * DAY).toISOString(),
      person: { id: "p3", email: "auditor@example.test", full_name: "An Auditor", auth_user_id: "a3" },
    });

    const queue = queueFor(
      tenant({ status: "read_only", status_changed_at: NOW.toISOString() }),
      [member(), soon],
      NOW
    );

    // Audit (3 days) above Governance (a year), and the undated sole-DPO item
    // last. Sorted by area, Governance would have led.
    expect(titles(queue)).toEqual([
      "External access expires",
      "Workspace is read-only",
      "You are the only Active DPO",
    ]);
    expect(queue.map((i) => i.where)).toEqual(["Audit", "Governance", "Governance"]);
  });

  it("puts overdue items above merely upcoming ones", () => {
    const expired = member({
      id: "expired",
      tier: "external_scoped",
      active_from: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      // Still "live" by the membership rule, but past its own notice period.
      active_to: new Date(NOW.getTime() + 1 * DAY).toISOString(),
      person: { id: "p4", email: "soon@example.test", full_name: null, auth_user_id: "a4" },
    });
    const later = member({
      id: "later",
      tier: "external_scoped",
      active_to: new Date(NOW.getTime() + 40 * DAY).toISOString(),
      person: { id: "p5", email: "later@example.test", full_name: null, auth_user_id: "a5" },
    });

    const queue = queueFor(tenant(), [member(), later, expired], NOW);
    const dated = queue.filter((i) => i.daysLeft !== null).map((i) => i.daysLeft!);
    expect([...dated].sort((a, b) => a - b)).toEqual(dated);
  });

  it("sorts undated items by severity, and §6 decides that severity", () => {
    // The same situation — a sole Active DPO — is a different problem depending
    // on why the company has a DPO at all.
    const forBasis = (legal_basis: TenantRow["legal_basis"]) =>
      queueFor(tenant({ legal_basis }), [member()], NOW)[0];

    const mandatory = forBasis("mandatory");
    const contractual = forBasis("contractual");
    const voluntary = forBasis("voluntary");

    expect(mandatory.severity).toBeGreaterThan(contractual.severity);
    expect(contractual.severity).toBeGreaterThan(voluntary.severity);
    expect(mandatory.detail).toContain("Art. 37");
    expect(contractual.detail).toContain("customer");

    expect([voluntary, mandatory].sort(byUrgency)[0]).toBe(mandatory);
  });

  it("keeps dated items above undated ones whatever their severity", () => {
    const dated: QueueItem = {
      id: "dated",
      title: "Dated",
      detail: "",
      where: "Audit",
      waitingOn: "-",
      owner: "outside",
      daysLeft: 300,
      clock: "",
      action: "Open",
      severity: 1,
    };
    const undated: QueueItem = { ...dated, id: "undated", title: "Undated", daysLeft: null, severity: 99 };

    expect([undated, dated].sort(byUrgency).map((i) => i.title)).toEqual(["Dated", "Undated"]);
  });
});

describe("blocking dependencies", () => {
  it("marks the roster chase as blocked while the workspace is read-only", () => {
    // Real, not illustrative: `app.tenant_is_writable` refuses roster writes on
    // a non-active tenant, so chasing is genuinely wasted effort until billing
    // is resolved.
    const unclaimed = member({
      tier: "staff",
      person: { id: "p6", email: "newhire@example.test", full_name: null, auth_user_id: null },
    });

    const queue = queueFor(tenant({ status: "read_only" }), [member(), unclaimed], NOW);
    const chase = queue.find((i) => i.title.includes("never signed in"));
    const readOnly = queue.find((i) => i.title === "Workspace is read-only");

    expect(chase?.blockedBy).toBe(readOnly?.id);
  });

  it("does not mark it blocked when the workspace is active", () => {
    const unclaimed = member({
      tier: "staff",
      person: { id: "p7", email: "newhire@example.test", full_name: null, auth_user_id: null },
    });

    const queue = queueFor(tenant(), [member(), unclaimed], NOW);
    expect(queue.find((i) => i.title.includes("never signed in"))?.blockedBy).toBeUndefined();
  });

  it("never points at an item that is not in the queue", () => {
    const unclaimed = member({
      tier: "staff",
      person: { id: "p8", email: "newhire@example.test", full_name: null, auth_user_id: null },
    });
    const queue = queueFor(tenant({ status: "read_only" }), [member(), unclaimed], NOW);
    const ids = new Set(queue.map((i) => i.id));

    for (const item of queue) {
      if (item.blockedBy) expect(ids.has(item.blockedBy)).toBe(true);
    }
  });
});

describe("filters", () => {
  const unclaimed = member({
    tier: "staff",
    person: { id: "p10", email: "newhire@example.test", full_name: null, auth_user_id: null },
  });
  const queue = queueFor(tenant({ status: "read_only" }), [member(), unclaimed], NOW);

  it("everything keeps the list intact", () => {
    expect(applyOwnerFilter(queue, "everything")).toHaveLength(queue.length);
  });

  it("splits the queue into owners without losing or duplicating a row", () => {
    const parts = (["you", "company", "outside"] as const).flatMap((f) =>
      applyOwnerFilter(queue, f)
    );
    expect(parts.map((i) => i.id).sort()).toEqual(queue.map((i) => i.id).sort());
  });

  it("returns an empty list rather than everything when nothing matches", () => {
    // A filter that silently falls back to showing everything would tell a DPO
    // there is work in a category that is actually empty.
    const quiet = queueFor(tenant(), [member(), member({ id: "second-dpo" })], NOW);
    expect(quiet).toHaveLength(0);
    expect(applyOwnerFilter(quiet, "you")).toEqual([]);
  });
});

describe("confidence tags", () => {
  it("tags each fact with where it came from, and admits the gap", () => {
    const fields = taggedFieldsFor(tenant(), [member()], NOW, "A customer contract required it");
    const byLabel = new Map(fields.map((f) => [f.label, f]));

    expect(byLabel.get("DPO basis")?.confidence).toBe("stated");
    expect(byLabel.get("People")?.confidence).toBe("inferred");
    expect(byLabel.get("Sector")?.confidence).toBe("unknown");

    // The unknown one is present with a null value rather than dropped: an
    // omitted field and an unanswered question look identical once you remove
    // them, and only one of those is a gap somebody should close.
    expect(byLabel.get("Sector")?.value).toBeNull();
    expect(fields).toHaveLength(3);
  });

  it("never reports an inferred figure as stated", () => {
    const fields = taggedFieldsFor(tenant(), [member(), member({ id: "b" })], NOW, "x");
    const people = fields.find((f) => f.label === "People");
    expect(people?.value).toBe("2 with access");
    expect(people?.confidence).not.toBe("stated");
  });
});

describe("a quiet workspace", () => {
  it("produces no items at all rather than filler", () => {
    // Two Active DPOs, nobody unclaimed, no external grants, active status.
    const queue = queueFor(tenant(), [member(), member({ id: "second" })], NOW);
    expect(queue).toEqual([]);
  });
});
