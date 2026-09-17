/**
 * The tab bar's segment→tab mapping (the fix for "the menu disappears").
 *
 * The one rule worth protecting here: five different intake-funnel routes
 * (§2 detection paths) must all light up the single Intake tab, and the tenant
 * root — reported as `null` by `useSelectedLayoutSegment()`, not as an absent
 * value — must light up Overview. Getting either wrong either breaks the tab
 * highlight or, worse, could make an unrelated segment look like it belongs to
 * a tier's tab set it was never given.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVE_DPO_TABS,
  STAFF_TABS,
  activeTabId,
  hrefForTab,
} from "@/app/tenants/[tenantId]/tenant-tabs";

describe("active_dpo tab set", () => {
  it("maps the tenant root (null segment) to Overview", () => {
    expect(activeTabId(ACTIVE_DPO_TABS, null)).toBe("overview");
  });

  it.each(["intake", "software-discovery", "vendors", "ai-review", "request-vendor"])(
    "maps the %s segment to the Intake tab",
    (segment) => {
      expect(activeTabId(ACTIVE_DPO_TABS, segment)).toBe("intake");
    }
  );

  it("maps register, incidents, training-admin, roster and settings to their own tabs", () => {
    expect(activeTabId(ACTIVE_DPO_TABS, "register")).toBe("register");
    expect(activeTabId(ACTIVE_DPO_TABS, "incidents")).toBe("incidents");
    expect(activeTabId(ACTIVE_DPO_TABS, "training-admin")).toBe("training-admin");
    expect(activeTabId(ACTIVE_DPO_TABS, "roster")).toBe("roster");
    expect(activeTabId(ACTIVE_DPO_TABS, "settings")).toBe("settings");
  });

  it("has exactly the seven tabs the spec names, no others", () => {
    expect(ACTIVE_DPO_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Register",
      "Intake",
      "Incidents",
      "Training",
      "People",
      "Settings",
    ]);
  });

  it("matches nothing for a page that has no tab, such as issued links", () => {
    expect(activeTabId(ACTIVE_DPO_TABS, "links")).toBeNull();
  });
});

describe("staff tab set", () => {
  it("has exactly the four tabs the spec names, no others", () => {
    expect(STAFF_TABS.map((t) => t.label)).toEqual([
      "Home",
      "Register",
      "My training",
      "Raise a request",
    ]);
  });

  it("maps my-tasks, register, training and request-vendor to their own tabs", () => {
    expect(activeTabId(STAFF_TABS, "my-tasks")).toBe("my-tasks");
    expect(activeTabId(STAFF_TABS, "register")).toBe("register");
    expect(activeTabId(STAFF_TABS, "training")).toBe("training");
    expect(activeTabId(STAFF_TABS, "request-vendor")).toBe("request-vendor");
  });

  // A staff member never gets a DPO-only tab, so none of the DPO-only routes
  // should ever resolve to a staff tab either.
  it("never resolves a DPO-only segment to a staff tab", () => {
    for (const segment of ["incidents", "roster", "settings", "training-admin", "intake"]) {
      expect(activeTabId(STAFF_TABS, segment)).toBeNull();
    }
  });

  it("does not light up staff's own Home tab for the active_dpo Overview segment", () => {
    expect(activeTabId(STAFF_TABS, null)).toBeNull();
  });
});

describe("hrefForTab", () => {
  it("points the tenant-root tab at the bare tenant URL, no trailing segment", () => {
    const overview = ACTIVE_DPO_TABS.find((t) => t.id === "overview")!;
    expect(hrefForTab("t-1", overview)).toBe("/tenants/t-1");
  });

  it("points every other tab at its own first segment", () => {
    const register = ACTIVE_DPO_TABS.find((t) => t.id === "register")!;
    expect(hrefForTab("t-1", register)).toBe("/tenants/t-1/register");

    const intake = ACTIVE_DPO_TABS.find((t) => t.id === "intake")!;
    expect(hrefForTab("t-1", intake)).toBe("/tenants/t-1/intake");
  });
});
