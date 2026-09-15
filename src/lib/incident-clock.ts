/**
 * The Article 33 clock, in one place.
 *
 * Art. 33(1) gives 72 hours from BECOMING AWARE — not from the breach
 * happening. Every function here takes `discoveredAt` for that reason, and the
 * database stamps the deadline from the same field, so a screen and a row can
 * never disagree about when something is due.
 *
 * "Overdue" here means the 72 hours have passed without a recorded
 * notification. It does not mean a law was broken: Art. 33(1) allows later
 * notification accompanied by reasons for the delay, and allows no notification
 * at all where the breach is unlikely to result in a risk. So the wording this
 * module produces says what is true — the window has closed — and leaves the
 * judgement to the DPO.
 */

export const NOTIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

export type ClockState = "notified" | "not_notifiable" | "overdue" | "due_soon" | "running";

export interface ClockInput {
  discoveredAt: string;
  notifiedAuthorityAt?: string | null;
  notifiability?: string | null;
  now?: number;
}

export interface Clock {
  state: ClockState;
  deadline: string;
  msRemaining: number;
  /** What a DPO reads. Plain, and never overstates what has happened. */
  label: string;
}

export function incidentClock(input: ClockInput): Clock {
  const now = input.now ?? Date.now();
  const discovered = Date.parse(input.discoveredAt);
  const deadlineMs = discovered + NOTIFICATION_WINDOW_MS;
  const deadline = new Date(deadlineMs).toISOString();
  const msRemaining = deadlineMs - now;

  if (input.notifiedAuthorityAt) {
    const late = Date.parse(input.notifiedAuthorityAt) > deadlineMs;
    return {
      state: "notified",
      deadline,
      msRemaining,
      label: late
        ? "Authority notified, after the 72 hours — reasons for the delay are required"
        : "Authority notified within 72 hours",
    };
  }

  // Art. 33(1): no notification is required where the breach is unlikely to
  // result in a risk. The clock stops being the question — but Art. 33(5)
  // still requires the decision to be documented, which the table enforces.
  if (input.notifiability === "not_notifiable") {
    return {
      state: "not_notifiable",
      deadline,
      msRemaining,
      label: "Assessed as not notifiable — the reasoning is on the record",
    };
  }

  if (msRemaining <= 0) {
    return {
      state: "overdue",
      deadline,
      msRemaining,
      label: `The 72 hours closed ${humanise(-msRemaining)} ago — notifying now needs reasons for the delay`,
    };
  }

  return {
    state: msRemaining <= 24 * 60 * 60 * 1000 ? "due_soon" : "running",
    deadline,
    msRemaining,
    label: `${humanise(msRemaining)} left to notify the authority`,
  };
}

function humanise(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Most urgent first: overdue, then closest to the deadline. */
export function byUrgency(a: Clock, b: Clock): number {
  const rank: Record<ClockState, number> = {
    overdue: 0,
    due_soon: 1,
    running: 2,
    not_notifiable: 3,
    notified: 4,
  };
  if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
  return a.msRemaining - b.msRemaining;
}
