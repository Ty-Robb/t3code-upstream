// @effect-diagnostics globalDate:off -- Windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
import {
  WORK_SUMMARY_CONTRACT_VERSION,
  type WorkSummary,
  type WorkSummaryPullRequest,
  type WorkSummaryTotals,
  type WorkSummaryWindow,
} from "@t3tools/contracts";

/** Open pull requests are re-read while a client watches; older than this, the shown state may have changed. */
export const WORK_SUMMARY_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

type Window = Pick<WorkSummaryWindow, "sinceTime" | "untilTime">;

function epochMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Half-open: the start instant belongs to the window and the end instant does not. */
export function isWithinWindow(value: string | null, window: Window): boolean {
  const ms = epochMs(value);
  const since = epochMs(window.sinceTime);
  const until = epochMs(window.untilTime);
  return ms !== null && since !== null && until !== null && ms >= since && ms < until;
}

/**
 * Collapses rows for the same pull request into one: the earliest sighting wins for when it was
 * opened or linked, and the most recently synced row wins for what state it is in now. A reopened
 * pull request therefore reads open when its newest sync says so, whatever older threads hold.
 */
export function dedupeWorkSummaryPullRequests(
  rows: ReadonlyArray<WorkSummaryPullRequest>,
): WorkSummaryPullRequest[] {
  const groups = new Map<string, WorkSummaryPullRequest[]>();
  for (const row of rows) {
    const group = groups.get(row.key);
    if (group === undefined) groups.set(row.key, [row]);
    else group.push(row);
  }
  return [...groups.values()].map((group) => {
    let freshest = group[0]!;
    for (const row of group) {
      if ((epochMs(row.syncedAt) ?? -Infinity) > (epochMs(freshest.syncedAt) ?? -Infinity)) {
        freshest = row;
      }
    }
    const earliest = (pick: (row: WorkSummaryPullRequest) => string | null) =>
      group
        .map(pick)
        .filter((value): value is string => epochMs(value) !== null)
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    // An older sync of the same terminal state may still carry the date a fresher one lacks.
    const dateFrom = (field: "mergedAt" | "closedAt", state: "merged" | "closed") =>
      freshest.state === state
        ? (freshest[field] ??
          group.find((row) => row.state === state && row[field] !== null)?.[field] ??
          null)
        : freshest[field];
    return {
      ...freshest,
      openedAt: earliest((row) => row.openedAt),
      linkedAt: earliest((row) => row.linkedAt) ?? freshest.linkedAt,
      mergedAt: dateFrom("mergedAt", "merged"),
      closedAt: dateFrom("closedAt", "closed"),
    };
  });
}

/**
 * Combines each reporting environment's summary into the totals a dashboard or sharing card shows.
 * Pull requests de-duplicate across environments by canonical key, so one PR linked from a laptop
 * and a remote server counts once. Thread and run counts add: their ids are environment-local.
 */
export function deriveWorkSummaryTotals(input: {
  readonly window: WorkSummaryWindow;
  readonly summaries: ReadonlyArray<WorkSummary>;
  readonly environmentsTotal: number;
  readonly now: number;
}): WorkSummaryTotals {
  const { window, summaries, now } = input;
  const compatible = summaries.filter(
    (summary) => summary.contractVersion === WORK_SUMMARY_CONTRACT_VERSION,
  );
  const rows = dedupeWorkSummaryPullRequests(compatible.flatMap((summary) => summary.pullRequests));

  const openedRows = rows.filter((row) => isWithinWindow(row.openedAt, window));
  const mergedRows = rows.filter(
    (row) => row.state === "merged" && isWithinWindow(row.mergedAt, window),
  );
  const outcome = { merged: 0, open: 0, closedUnmerged: 0, unknown: 0 };
  for (const row of openedRows) {
    if (row.state === "merged") outcome.merged += 1;
    else if (row.state === "open") outcome.open += 1;
    else if (row.state === "closed") outcome.closedUnmerged += 1;
    else outcome.unknown += 1;
  }
  const counted = new Set([...openedRows, ...mergedRows]);
  const staleStatus = [...counted].filter((row) => {
    if (row.state !== "open") return false;
    const syncedMs = epochMs(row.syncedAt);
    return syncedMs === null || now - syncedMs > WORK_SUMMARY_STALE_AFTER_MS;
  }).length;

  return {
    window,
    coverage: {
      environmentsReporting: compatible.length,
      environmentsTotal: input.environmentsTotal,
    },
    runsCompleted: compatible.reduce((sum, summary) => sum + summary.runsCompleted, 0),
    threadsWithCompletedRuns: compatible.reduce(
      (sum, summary) => sum + summary.threadsWithCompletedRuns,
      0,
    ),
    threadsSettled: compatible.reduce((sum, summary) => sum + summary.threadsSettled, 0),
    pullRequests: {
      opened: openedRows.length,
      openedOutcome: outcome,
      merged: mergedRows.length,
      mergedWithoutDate: rows.filter(
        (row) =>
          row.state === "merged" && row.mergedAt === null && isWithinWindow(row.linkedAt, window),
      ).length,
      staleStatus,
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const wallAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wallAsUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day starts in `timeZone`; month is 1-based and day may overflow it. */
function startOfZonedDay(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  // The offset depends on the instant, so settle it in two passes across a DST change.
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return instant;
}

/**
 * The period a viewer means by "last N days": whole calendar days in their zone, ending with
 * today. One day means the trailing 24 hours instead, since "today" would be a few hours of work
 * at midnight. Half-open and ends at or after `now`, so work finished this minute is included.
 */
export function makeWorkSummaryWindow(
  days: number,
  now: Date = new Date(),
  zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): WorkSummaryWindow {
  let timeZone = zone;
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  if (days <= 1) {
    const untilMs = Math.ceil((now.getTime() + 1) / MINUTE_MS) * MINUTE_MS;
    return {
      sinceTime: new Date(untilMs - 24 * HOUR_MS).toISOString(),
      untilTime: new Date(untilMs).toISOString(),
      timeZone,
    };
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year = 0, month = 1, day = 1] = today.split("-").map((part) => Number.parseInt(part, 10));
  return {
    sinceTime: new Date(startOfZonedDay(year, month, day - (days - 1), timeZone)).toISOString(),
    untilTime: new Date(startOfZonedDay(year, month, day + 1, timeZone)).toISOString(),
    timeZone,
  };
}
