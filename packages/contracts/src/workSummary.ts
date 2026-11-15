import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";

/** Bump for incompatible WorkSummary changes; skipped unknown array variants need no bump. */
export const WORK_SUMMARY_CONTRACT_VERSION = 1 as const;

/** Longest window one read covers; the scan reads every pull request link, so keep it bounded. */
export const WORK_SUMMARY_MAX_WINDOW_DAYS = 400 as const;

/**
 * Half-open window: `sinceTime` is included and `untilTime` is not, so back-to-back windows never
 * count an event twice. Clients derive both from the viewer's own calendar days.
 */
export const WorkSummaryInput = Schema.Struct({
  sinceTime: IsoDateTime,
  untilTime: IsoDateTime,
  /** Omit for every project in the environment. Project ids are environment-local. */
  projectIds: Schema.optional(Schema.Array(ProjectId)),
});
export type WorkSummaryInput = typeof WorkSummaryInput.Type;

/**
 * One pull request after de-duplicating every thread link to it. Carries no titles or branch
 * names, so a summary can leave the environment without leaking what the work was.
 */
export const WorkSummaryPullRequest = Schema.Struct({
  /** Canonical `host/repository#number`; equal keys are the same pull request across threads and environments. */
  key: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  /**
   * When T3 saw an agent or the Create PR flow open it (the earliest `created` link). Null for
   * pull requests that were only linked: the host's own creation time is not stored.
   */
  openedAt: Schema.NullOr(IsoDateTime),
  /** The earliest time any thread linked it; places a merged pull request that has no merge date. */
  linkedAt: IsoDateTime,
  /** Newest host state T3 read. Null when no thread ever synced a snapshot. */
  state: Schema.NullOr(PullRequestState),
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  /** When `state` was last read from the host. Null with a null `state`. */
  syncedAt: Schema.NullOr(IsoDateTime),
});
export type WorkSummaryPullRequest = typeof WorkSummaryPullRequest.Type;

export const WorkSummaryReadReason = Schema.Literals(["invalidWindow", "readFailed"]);
export type WorkSummaryReadReason = typeof WorkSummaryReadReason.Type;

export class WorkSummaryReadError extends Schema.TaggedError<WorkSummaryReadError>()(
  "WorkSummaryReadError",
  {
    reason: WorkSummaryReadReason,
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Work summary read failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * What one environment persisted for the window. Thread and run counts are local to the
 * environment; pull requests stay as rows so a client can de-duplicate across environments.
 */
export const WorkSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: IsoDateTime,
  sinceTime: IsoDateTime,
  untilTime: IsoDateTime,
  /** Runs whose persisted status is `completed` and whose `completedAt` is in the window. */
  runsCompleted: NonNegativeInt,
  /** Distinct threads behind `runsCompleted`. */
  threadsWithCompletedRuns: NonNegativeInt,
  /** Threads whose `settledAt` is in the window and that the user has not forced active. */
  threadsSettled: NonNegativeInt,
  /**
   * Pull requests opened in the window, merged in the window, or merged with no merge date and
   * first linked in the window. Pull requests outside all three are not sent.
   */
  pullRequests: ForwardCompatibleArray(WorkSummaryPullRequest),
});
export type WorkSummary = typeof WorkSummary.Type;

export const WorkSummaryWindow = Schema.Struct({
  sinceTime: IsoDateTime,
  untilTime: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
});
export type WorkSummaryWindow = typeof WorkSummaryWindow.Type;

/** How many reporting environments contributed; shown beside every total so partial data is visible. */
export const WorkSummaryCoverage = Schema.Struct({
  environmentsReporting: NonNegativeInt,
  environmentsTotal: NonNegativeInt,
});
export type WorkSummaryCoverage = typeof WorkSummaryCoverage.Type;

/**
 * Where the pull requests opened in the window stand now. The four sum to `opened`, and
 * `unknown` counts those no thread ever synced from the host.
 */
export const WorkSummaryOpenedOutcome = Schema.Struct({
  merged: NonNegativeInt,
  open: NonNegativeInt,
  closedUnmerged: NonNegativeInt,
  unknown: NonNegativeInt,
});
export type WorkSummaryOpenedOutcome = typeof WorkSummaryOpenedOutcome.Type;

/**
 * The values a dashboard shows and a sharing card may print. Every field is a count of persisted
 * events or host-reported statuses in the window. Nothing here estimates time or money saved.
 */
export const WorkSummaryTotals = Schema.Struct({
  window: WorkSummaryWindow,
  coverage: WorkSummaryCoverage,
  runsCompleted: NonNegativeInt,
  /** Summed across environments, whose thread ids never overlap. */
  threadsWithCompletedRuns: NonNegativeInt,
  threadsSettled: NonNegativeInt,
  pullRequests: Schema.Struct({
    /** Distinct pull requests T3 saw opened in the window; excludes ones that were only linked. */
    opened: NonNegativeInt,
    openedOutcome: WorkSummaryOpenedOutcome,
    /** Distinct linked pull requests the host reports merged, with `mergedAt` inside the window. */
    merged: NonNegativeInt,
    /** Merged pull requests first linked in the window whose host gave no merge date, so no period fits. */
    mergedWithoutDate: NonNegativeInt,
    /** Counted pull requests still shown open whose state was last read from the host over 48 hours ago. */
    staleStatus: NonNegativeInt,
  }),
});
export type WorkSummaryTotals = typeof WorkSummaryTotals.Type;
