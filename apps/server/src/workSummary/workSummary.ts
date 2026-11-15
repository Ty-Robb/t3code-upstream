import {
  WORK_SUMMARY_CONTRACT_VERSION,
  WORK_SUMMARY_MAX_WINDOW_DAYS,
  type WorkSummary,
  type WorkSummaryInput,
  type WorkSummaryPullRequest,
  WorkSummaryReadError,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { dedupeWorkSummaryPullRequests } from "@t3tools/shared/workSummary";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const isReadError = Schema.is(WorkSummaryReadError);

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const invalidWindow = (detail: string) =>
  new WorkSummaryReadError({ reason: "invalidWindow", detail });

interface LinkRow {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly source: string;
  readonly linkedAt: string;
  readonly state: "open" | "closed" | "merged" | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly syncedAt: string | null;
}

/**
 * Counts what this environment persisted for a window. Runs and settled threads skip subagent
 * threads, side chats and deleted threads: the parent already carries the work, or the history is
 * gone. Pull requests are real wherever they were linked, so every live thread's links count and
 * de-duplicate by canonical key before they leave.
 */
export const readWorkSummary = Effect.fn("WorkSummary.read")(
  function* (input: WorkSummaryInput) {
    const since = Date.parse(input.sinceTime);
    const until = Date.parse(input.untilTime);
    if (Number.isNaN(since) || Number.isNaN(until) || since >= until) {
      return yield* invalidWindow("The window must start before it ends.");
    }
    if (until - since > WORK_SUMMARY_MAX_WINDOW_DAYS * DAY_MS) {
      return yield* invalidWindow(
        `The window may span at most ${WORK_SUMMARY_MAX_WINDOW_DAYS} days.`,
      );
    }
    const readAt = isoOf(yield* Clock.currentTimeMillis);
    const sinceTime = isoOf(since);
    const untilTime = isoOf(until);
    const empty: WorkSummary = {
      contractVersion: WORK_SUMMARY_CONTRACT_VERSION,
      readAt,
      sinceTime,
      untilTime,
      runsCompleted: 0,
      threadsWithCompletedRuns: 0,
      threadsSettled: 0,
      pullRequests: [],
    };
    if (input.projectIds?.length === 0) return empty;

    const sql = yield* SqlClient.SqlClient;
    const scope =
      input.projectIds === undefined ? sql`` : sql`AND t.project_id IN ${sql.in(input.projectIds)}`;
    // Listed threads only: a subagent or side chat belongs to the thread that launched it.
    const counted = sql`
      t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
      AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
    `;

    const [runs] = yield* sql<{ runs: number; threads: number }>`
      SELECT COUNT(*) AS runs, COUNT(DISTINCT r.thread_id) AS threads
      FROM orchestration_v2_projection_runs AS r
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
      WHERE r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND julianday(r.completed_at) >= julianday(${sinceTime})
        AND julianday(r.completed_at) < julianday(${untilTime})
        AND ${counted} ${scope}
    `.pipe(NodeSqliteClient.readOnly);

    const [settled] = yield* sql<{ settled: number }>`
      SELECT COUNT(*) AS settled
      FROM orchestration_v2_projection_threads AS t
      WHERE json_extract(t.payload_json, '$.settledAt') IS NOT NULL
        AND julianday(json_extract(t.payload_json, '$.settledAt')) >= julianday(${sinceTime})
        AND julianday(json_extract(t.payload_json, '$.settledAt')) < julianday(${untilTime})
        AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'active'
        AND ${counted} ${scope}
    `.pipe(NodeSqliteClient.readOnly);

    // Every link, and every row is sent: the client de-duplicates across environments, so an
    // environment cannot drop a row whose newer sync would outvote another environment's older one.
    const links = yield* sql<LinkRow>`
      SELECT json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number,
        json_extract(link.value, '$.url') AS url,
        json_extract(link.value, '$.source') AS source,
        json_extract(link.value, '$.linkedAt') AS "linkedAt",
        json_extract(link.value, '$.snapshot.state') AS state,
        json_extract(link.value, '$.snapshot.mergedAt') AS "mergedAt",
        json_extract(link.value, '$.snapshot.closedAt') AS "closedAt",
        json_extract(link.value, '$.snapshot.syncedAt') AS "syncedAt"
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.pullRequests') AS link
      WHERE json_extract(link.value, '$.source') != 'stack-dismissed'
        AND t.deleted_at IS NULL ${scope}
    `.pipe(NodeSqliteClient.readOnly);

    const rows: WorkSummaryPullRequest[] = links.map((link) => ({
      key: threadPullRequestKeyOf(link),
      host: link.host,
      repository: link.repository,
      number: link.number,
      // Only a link made when a command or the Create PR flow opened it dates the opening.
      openedAt: link.source === "created" ? link.linkedAt : null,
      linkedAt: link.linkedAt,
      state: link.state,
      mergedAt: link.mergedAt ?? null,
      closedAt: link.closedAt ?? null,
      syncedAt: link.syncedAt ?? null,
    }));
    return {
      ...empty,
      runsCompleted: runs?.runs ?? 0,
      threadsWithCompletedRuns: runs?.threads ?? 0,
      threadsSettled: settled?.settled ?? 0,
      pullRequests: dedupeWorkSummaryPullRequests(rows),
    } satisfies WorkSummary;
  },
  Effect.mapError((cause) =>
    isReadError(cause)
      ? cause
      : new WorkSummaryReadError({
          reason: "readFailed",
          detail: "Could not read work from the database.",
          cause,
        }),
  ),
);
