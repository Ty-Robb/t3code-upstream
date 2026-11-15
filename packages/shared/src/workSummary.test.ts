// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import {
  WORK_SUMMARY_CONTRACT_VERSION,
  type WorkSummary,
  type WorkSummaryPullRequest,
  type WorkSummaryWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WORK_SUMMARY_STALE_AFTER_MS,
  dedupeWorkSummaryPullRequests,
  deriveWorkSummaryTotals,
  isWithinWindow,
  makeWorkSummaryWindow,
} from "./workSummary.ts";

const window: WorkSummaryWindow = {
  sinceTime: "2026-10-01T00:00:00.000Z",
  untilTime: "2026-11-01T00:00:00.000Z",
  timeZone: "UTC",
};
const NOW = Date.parse("2026-11-01T00:00:00.000Z");

const pr = (overrides: Partial<WorkSummaryPullRequest>): WorkSummaryPullRequest => ({
  key: "github.com/acme/web#1",
  host: "github.com",
  repository: "acme/web",
  number: 1,
  openedAt: null,
  linkedAt: "2026-10-02T00:00:00.000Z",
  state: "open",
  mergedAt: null,
  closedAt: null,
  syncedAt: "2026-10-31T12:00:00.000Z",
  ...overrides,
});

const summary = (overrides: Partial<WorkSummary> = {}): WorkSummary => ({
  contractVersion: WORK_SUMMARY_CONTRACT_VERSION,
  readAt: "2026-11-01T00:00:00.000Z",
  sinceTime: window.sinceTime,
  untilTime: window.untilTime,
  runsCompleted: 0,
  threadsWithCompletedRuns: 0,
  threadsSettled: 0,
  pullRequests: [],
  ...overrides,
});

const totals = (summaries: ReadonlyArray<WorkSummary>, environmentsTotal = summaries.length) =>
  deriveWorkSummaryTotals({ window, summaries, environmentsTotal, now: NOW });

describe("isWithinWindow", () => {
  it("includes the start instant, excludes the end, and rejects unparseable times", () => {
    expect(isWithinWindow(window.sinceTime, window)).toBe(true);
    expect(isWithinWindow("2026-10-31T23:59:59.999Z", window)).toBe(true);
    expect(isWithinWindow(window.untilTime, window)).toBe(false);
    expect(isWithinWindow("2026-10-15T09:00:00.000+02:00", window)).toBe(true);
    expect(isWithinWindow("nope", window)).toBe(false);
    expect(isWithinWindow(null, window)).toBe(false);
  });
});

describe("dedupeWorkSummaryPullRequests", () => {
  it("keeps the earliest sighting but the freshest status, so a reopened pull request reads open", () => {
    const [row, ...rest] = dedupeWorkSummaryPullRequests([
      pr({
        openedAt: "2026-10-03T00:00:00.000Z",
        state: "closed",
        closedAt: "2026-10-04T00:00:00.000Z",
        syncedAt: "2026-10-04T00:00:00.000Z",
      }),
      pr({
        linkedAt: "2026-10-20T00:00:00.000Z",
        state: "open",
        syncedAt: "2026-10-25T00:00:00.000Z",
      }),
    ]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      openedAt: "2026-10-03T00:00:00.000Z",
      linkedAt: "2026-10-02T00:00:00.000Z",
      state: "open",
    });
  });

  it("borrows a merge date from an older sync of the same merged state", () => {
    const [row] = dedupeWorkSummaryPullRequests([
      pr({
        state: "merged",
        mergedAt: "2026-10-09T00:00:00.000Z",
        syncedAt: "2026-10-09T01:00:00.000Z",
      }),
      pr({ state: "merged", mergedAt: null, syncedAt: "2026-10-10T00:00:00.000Z" }),
    ]);
    expect(row?.mergedAt).toBe("2026-10-09T00:00:00.000Z");
  });

  it("never reads an unsynced row as fresher than a synced one", () => {
    const [row] = dedupeWorkSummaryPullRequests([
      pr({ state: null, syncedAt: null }),
      pr({ state: "merged", mergedAt: "2026-10-09T00:00:00.000Z" }),
    ]);
    expect(row?.state).toBe("merged");
  });
});

describe("deriveWorkSummaryTotals", () => {
  it("separates opened from merged and reports where the opened ones stand now", () => {
    const result = totals([
      summary({
        runsCompleted: 12,
        threadsWithCompletedRuns: 5,
        threadsSettled: 3,
        pullRequests: [
          // Opened and merged in the window.
          pr({
            key: "k/1",
            number: 1,
            openedAt: "2026-10-02T00:00:00.000Z",
            state: "merged",
            mergedAt: "2026-10-03T00:00:00.000Z",
          }),
          // Opened in the window, merged after it ended: opened, outcome merged, not merged here.
          pr({
            key: "k/2",
            number: 2,
            openedAt: "2026-10-30T00:00:00.000Z",
            state: "merged",
            mergedAt: "2026-11-02T00:00:00.000Z",
          }),
          // Opened before the window, merged inside it: merged only.
          pr({
            key: "k/3",
            number: 3,
            openedAt: "2026-09-02T00:00:00.000Z",
            state: "merged",
            mergedAt: "2026-10-04T00:00:00.000Z",
          }),
          // Only linked, merged inside the window: merged, never opened.
          pr({ key: "k/4", number: 4, state: "merged", mergedAt: "2026-10-05T00:00:00.000Z" }),
          pr({ key: "k/5", number: 5, openedAt: "2026-10-06T00:00:00.000Z", state: "open" }),
          pr({
            key: "k/6",
            number: 6,
            openedAt: "2026-10-06T00:00:00.000Z",
            state: "closed",
            closedAt: "2026-10-07T00:00:00.000Z",
          }),
          pr({
            key: "k/7",
            number: 7,
            openedAt: "2026-10-06T00:00:00.000Z",
            state: null,
            syncedAt: null,
          }),
          // A merged pull request with no date cannot be placed in a period.
          pr({
            key: "k/8",
            number: 8,
            state: "merged",
            mergedAt: null,
            linkedAt: "2026-10-08T00:00:00.000Z",
          }),
        ],
      }),
    ]);

    expect(result).toMatchObject({
      runsCompleted: 12,
      threadsWithCompletedRuns: 5,
      threadsSettled: 3,
      pullRequests: {
        opened: 5,
        openedOutcome: { merged: 2, open: 1, closedUnmerged: 1, unknown: 1 },
        merged: 3,
        mergedWithoutDate: 1,
      },
    });
    const { merged, open, closedUnmerged, unknown } = result.pullRequests.openedOutcome;
    expect(merged + open + closedUnmerged + unknown).toBe(result.pullRequests.opened);
  });

  it("counts a pull request once when two environments link it, and adds their local counts", () => {
    const shared = pr({
      openedAt: "2026-10-02T00:00:00.000Z",
      state: "merged",
      mergedAt: "2026-10-03T00:00:00.000Z",
    });
    const result = totals([
      summary({ runsCompleted: 4, threadsWithCompletedRuns: 2, pullRequests: [shared] }),
      summary({
        runsCompleted: 6,
        threadsWithCompletedRuns: 3,
        pullRequests: [
          {
            ...shared,
            openedAt: null,
            state: "open",
            mergedAt: null,
            syncedAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(result.runsCompleted).toBe(10);
    expect(result.threadsWithCompletedRuns).toBe(5);
    expect(result.pullRequests.opened).toBe(1);
    expect(result.pullRequests.merged).toBe(1);
  });

  it("flags open pull requests whose status was last read more than 48 hours ago", () => {
    const old = new Date(NOW - WORK_SUMMARY_STALE_AFTER_MS - 1).toISOString();
    const result = totals([
      summary({
        pullRequests: [
          pr({ key: "k/1", number: 1, openedAt: "2026-10-02T00:00:00.000Z", syncedAt: old }),
          pr({ key: "k/2", number: 2, openedAt: "2026-10-02T00:00:00.000Z" }),
          pr({
            key: "k/3",
            number: 3,
            openedAt: "2026-10-02T00:00:00.000Z",
            state: "merged",
            mergedAt: "2026-10-03T00:00:00.000Z",
            syncedAt: old,
          }),
        ],
      }),
    ]);
    expect(result.pullRequests.staleStatus).toBe(1);
  });

  it("reports coverage and ignores summaries from other contract versions", () => {
    const result = totals(
      [
        summary({ runsCompleted: 3 }),
        summary({ contractVersion: 0, runsCompleted: 99 }),
        summary({ contractVersion: 2, runsCompleted: 99 }),
      ],
      3,
    );
    expect(result.coverage).toEqual({ environmentsReporting: 1, environmentsTotal: 3 });
    expect(result.runsCompleted).toBe(3);
  });

  it("reports zeros, not an error, for an empty period", () => {
    expect(totals([summary()]).pullRequests).toEqual({
      opened: 0,
      openedOutcome: { merged: 0, open: 0, closedUnmerged: 0, unknown: 0 },
      merged: 0,
      mergedWithoutDate: 0,
      staleStatus: 0,
    });
  });
});

describe("makeWorkSummaryWindow", () => {
  it("spans whole calendar days in the viewer's zone, ending after now", () => {
    // 2026-11-15 22:30 in New York is already the 16th in UTC; the window follows the viewer.
    const window = makeWorkSummaryWindow(
      7,
      new Date("2026-11-16T03:30:00.000Z"),
      "America/New_York",
    );
    expect(window).toEqual({
      sinceTime: "2026-11-09T05:00:00.000Z",
      untilTime: "2026-11-16T05:00:00.000Z",
      timeZone: "America/New_York",
    });
  });

  it("keeps midnight local across the daylight saving change that falls inside the window", () => {
    // US clocks went back on 2026-11-01, so the window start (Oct 30, EDT) and end (Nov 3, EST) differ by an hour.
    const window = makeWorkSummaryWindow(
      5,
      new Date("2026-11-03T15:00:00.000Z"),
      "America/New_York",
    );
    expect(window.sinceTime).toBe("2026-10-30T04:00:00.000Z");
    expect(window.untilTime).toBe("2026-11-04T05:00:00.000Z");
  });

  it("reads one day as the trailing 24 hours, rounded up to the next minute", () => {
    const window = makeWorkSummaryWindow(1, new Date("2026-11-15T10:30:20.000Z"), "UTC");
    expect(window).toEqual({
      sinceTime: "2026-11-14T10:31:00.000Z",
      untilTime: "2026-11-15T10:31:00.000Z",
      timeZone: "UTC",
    });
  });

  it("falls back to UTC for a zone the runtime does not know", () => {
    expect(
      makeWorkSummaryWindow(2, new Date("2026-11-15T10:00:00.000Z"), "Not/AZone").timeZone,
    ).toBe("UTC");
  });
});
