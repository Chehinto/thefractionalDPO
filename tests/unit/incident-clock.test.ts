/**
 * The Article 33 clock.
 *
 * The distinction these tests exist to protect: the 72 hours run from
 * DISCOVERY, not from the breach. Getting that backwards either invents a
 * missed deadline for an old breach found today, or hides a real one.
 */

import { describe, expect, it } from "vitest";
import { incidentClock, NOTIFICATION_WINDOW_MS } from "@/lib/incident-clock";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("when the clock starts", () => {
  // A breach that happened in March and was found today is due in 72 hours,
  // not overdue by six months.
  it("runs from discovery, however long ago the breach happened", () => {
    const clock = incidentClock({ discoveredAt: iso(0), now: NOW });
    expect(clock.state).toBe("running");
    expect(Date.parse(clock.deadline) - NOW).toBe(NOTIFICATION_WINDOW_MS);
  });

  it("warns inside the last day", () => {
    expect(incidentClock({ discoveredAt: iso(-60 * 3_600_000), now: NOW }).state).toBe("due_soon");
    expect(incidentClock({ discoveredAt: iso(-2 * 3_600_000), now: NOW }).state).toBe("running");
  });
});

describe("when the window has closed", () => {
  const clock = incidentClock({ discoveredAt: iso(-80 * 3_600_000), now: NOW });

  it("says the window closed, not that a law was broken", () => {
    expect(clock.state).toBe("overdue");
    expect(clock.label).toContain("closed");
    expect(clock.label).toContain("reasons for the delay");
    expect(clock.label).not.toContain("breach of");
  });
});

describe("once a decision has been recorded", () => {
  it("stops counting when the authority has been notified", () => {
    const clock = incidentClock({
      discoveredAt: iso(-10 * 3_600_000),
      notifiedAuthorityAt: iso(-1 * 3_600_000),
      now: NOW,
    });
    expect(clock.state).toBe("notified");
    expect(clock.label).toContain("within 72 hours");
  });

  // Art. 33(1) permits late notification with reasons; the label has to say so
  // rather than implying the record is simply wrong.
  it("marks a late notification as late, and names what it needs", () => {
    const clock = incidentClock({
      discoveredAt: iso(-100 * 3_600_000),
      notifiedAuthorityAt: iso(-1 * 3_600_000),
      now: NOW,
    });
    expect(clock.label).toContain("after the 72 hours");
    expect(clock.label).toContain("reasons for the delay");
  });

  // Art. 33(1): no notification where risk is unlikely. The clock is no longer
  // the question, but Art. 33(5) still wants the reasoning on file.
  it("stops counting when assessed as not notifiable, and says the reasoning is recorded", () => {
    const clock = incidentClock({
      discoveredAt: iso(-100 * 3_600_000),
      notifiability: "not_notifiable",
      now: NOW,
    });
    expect(clock.state).toBe("not_notifiable");
    expect(clock.label).toContain("reasoning is on the record");
  });
});
