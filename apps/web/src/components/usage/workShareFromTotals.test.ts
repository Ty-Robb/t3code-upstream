import type { WorkSummaryTotals } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workShareInputFromTotals } from "./workShareFromTotals";

const totals = (
  pullRequests: Partial<WorkSummaryTotals["pullRequests"]> = {},
): WorkSummaryTotals => ({
  window: {
    sinceTime: "2026-11-09T00:00:00.000Z",
    untilTime: "2026-11-16T00:00:00.000Z",
    timeZone: "UTC",
  },
  coverage: { environmentsReporting: 2, environmentsTotal: 3 },
  runsCompleted: 40,
  threadsWithCompletedRuns: 9,
  threadsSettled: 7,
  pullRequests: {
    opened: 4,
    openedOutcome: { merged: 3, open: 1, closedUnmerged: 0, unknown: 0 },
    merged: 5,
    mergedWithoutDate: 0,
    staleStatus: 0,
    ...pullRequests,
  },
});

describe("workShareInputFromTotals", () => {
  const context = { periodLabel: "Last 7 days", projectLabel: null };

  it("passes verified counts and coverage, and a merge rate over known outcomes", () => {
    expect(workShareInputFromTotals(totals(), context)).toEqual({
      source: "dashboard",
      periodLabel: "Last 7 days",
      projectLabel: null,
      counts: { pullRequestsOpened: 4, pullRequestsMerged: 5, threadsWorkedOn: 9 },
      coverage: { environmentsReporting: 2, environmentsTotal: 3 },
      insights: { mergeRatePercent: 75 },
    });
  });

  it("omits the merge rate when an opened pull request was never read or none opened", () => {
    const unread = totals({
      openedOutcome: { merged: 2, open: 1, closedUnmerged: 0, unknown: 1 },
    });
    expect(workShareInputFromTotals(unread, context).insights).toBeUndefined();
    const none = totals({
      opened: 0,
      openedOutcome: { merged: 0, open: 0, closedUnmerged: 0, unknown: 0 },
    });
    expect(workShareInputFromTotals(none, context).insights).toBeUndefined();
  });
});
