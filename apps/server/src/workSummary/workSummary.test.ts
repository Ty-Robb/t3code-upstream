import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readWorkSummary } from "./workSummary.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const SINCE = "2026-10-01T00:00:00.000Z";
const UNTIL = "2026-11-01T00:00:00.000Z";
const input = { sinceTime: SINCE, untilTime: UNTIL };

interface ThreadFixture {
  readonly id: string;
  readonly projectId?: string;
  readonly deleted?: boolean;
  readonly lineage?: Record<string, unknown>;
  readonly settledAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly links?: ReadonlyArray<Record<string, unknown>>;
}

const link = (overrides: Record<string, unknown>) => ({
  host: "github.com",
  repository: "acme/web",
  number: 1,
  url: "https://github.com/acme/web/pull/1",
  source: "manual",
  linkedAt: "2026-09-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
  ...overrides,
});

const snapshot = (overrides: Record<string, unknown>) => ({
  state: "open",
  title: "Private title",
  headBranch: "private-branch",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-10-05T00:00:00.000Z",
  syncedAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

const insertThread = (fixture: ThreadFixture) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodePayload({
      lineage: fixture.lineage ?? { parentThreadId: null, relationshipToParent: null },
      settledAt: fixture.settledAt ?? null,
      settledOverride: fixture.settledOverride ?? null,
      pullRequests: fixture.links ?? [],
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${fixture.id}, ${fixture.projectId ?? "project-1"}, ${fixture.id}, 'codex', 'full-access',
        'default', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
        ${fixture.deleted === true ? "2026-10-10T00:00:00.000Z" : null}, ${payload}
      )
    `;
  });

let runOrdinal = 0;
const insertRun = (threadId: string, status: string, completedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    runOrdinal += 1;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
      ) VALUES (
        ${`run-${runOrdinal}`}, ${threadId}, ${runOrdinal}, 'codex', ${status},
        '2026-09-01T00:00:00.000Z', ${completedAt}, '{}'
      )
    `;
  });

it.effect(
  "counts only completed runs in a half-open window, on listed non-deleted threads, scoped by project",
  () =>
    Effect.gen(function* () {
      yield* insertThread({ id: "a" });
      yield* insertThread({ id: "b" });
      yield* insertThread({ id: "other-project", projectId: "project-2" });
      yield* insertThread({ id: "deleted", deleted: true });
      yield* insertThread({
        id: "subagent",
        lineage: { parentThreadId: "a", relationshipToParent: "subagent" },
      });
      yield* insertThread({
        id: "side-chat",
        lineage: { parentThreadId: null, relationshipToParent: null, sideChat: true },
      });
      yield* insertRun("a", "completed", "2026-10-01T00:00:00.000Z"); // start is included
      yield* insertRun("a", "completed", "2026-10-15T12:00:00.000Z");
      yield* insertRun("b", "completed", "2026-10-31T23:59:59.999Z");
      yield* insertRun("a", "completed", "2026-11-01T00:00:00.000Z"); // end is excluded
      yield* insertRun("a", "completed", "2026-09-30T23:59:59.999Z");
      yield* insertRun("a", "failed", "2026-10-10T00:00:00.000Z");
      yield* insertRun("a", "cancelled", "2026-10-10T00:00:00.000Z");
      yield* insertRun("a", "interrupted", "2026-10-10T00:00:00.000Z");
      yield* insertRun("a", "rolled_back", "2026-10-10T00:00:00.000Z");
      yield* insertRun("a", "running", null);
      yield* insertRun("other-project", "completed", "2026-10-10T00:00:00.000Z");
      yield* insertRun("deleted", "completed", "2026-10-10T00:00:00.000Z");
      yield* insertRun("subagent", "completed", "2026-10-10T00:00:00.000Z");
      yield* insertRun("side-chat", "completed", "2026-10-10T00:00:00.000Z");
      // Offsets compare as instants, not as text.
      yield* insertRun("b", "completed", "2026-10-20T09:00:00.000+02:00");

      const all = yield* readWorkSummary(input);
      assert.strictEqual(all.runsCompleted, 5);
      assert.strictEqual(all.threadsWithCompletedRuns, 3);

      const scoped = yield* readWorkSummary({ ...input, projectIds: ["project-1" as never] });
      assert.strictEqual(scoped.runsCompleted, 4);
      assert.strictEqual(scoped.threadsWithCompletedRuns, 2);

      const none = yield* readWorkSummary({ ...input, projectIds: [] });
      assert.strictEqual(none.runsCompleted, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("counts settled threads by settledAt unless the user forced them active", () =>
  Effect.gen(function* () {
    yield* insertThread({ id: "settled", settledAt: "2026-10-12T00:00:00.000Z" });
    yield* insertThread({
      id: "forced-settled",
      settledAt: "2026-10-12T00:00:00.000Z",
      settledOverride: "settled",
    });
    yield* insertThread({
      id: "forced-active",
      settledAt: "2026-10-12T00:00:00.000Z",
      settledOverride: "active",
    });
    yield* insertThread({ id: "before", settledAt: "2026-09-12T00:00:00.000Z" });
    yield* insertThread({ id: "unsettled" });
    yield* insertThread({ id: "deleted", deleted: true, settledAt: "2026-10-12T00:00:00.000Z" });

    const summary = yield* readWorkSummary(input);
    assert.strictEqual(summary.threadsSettled, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "de-duplicates a pull request linked from several threads and prefers the freshest status",
  () =>
    Effect.gen(function* () {
      const created = link({ source: "created", linkedAt: "2026-10-03T00:00:00.000Z" });
      yield* insertThread({
        id: "opener",
        links: [
          {
            ...created,
            snapshot: snapshot({
              state: "closed",
              closedAt: "2026-10-04T00:00:00.000Z",
              syncedAt: "2026-10-04T00:00:00.000Z",
            }),
          },
        ],
      });
      // Reopened and merged later: the newer sync, from another thread and URL host casing, wins.
      yield* insertThread({
        id: "later",
        links: [
          link({
            host: "GitHub.com",
            repository: "Acme/Web",
            linkedAt: "2026-10-20T00:00:00.000Z",
            snapshot: snapshot({
              state: "merged",
              mergedAt: "2026-10-21T00:00:00.000Z",
              syncedAt: "2026-10-21T01:00:00.000Z",
            }),
          }),
        ],
      });
      // Same thread, same PR number in another repository: a different pull request.
      yield* insertThread({
        id: "other-repo",
        links: [
          link({
            repository: "acme/api",
            source: "created",
            linkedAt: "2026-10-06T00:00:00.000Z",
            snapshot: snapshot({ state: "open" }),
          }),
        ],
      });

      const { pullRequests } = yield* readWorkSummary(input);
      assert.strictEqual(pullRequests.length, 2);
      const web = pullRequests.find((row) => row.repository.toLowerCase() === "acme/web");
      assert.strictEqual(web?.openedAt, "2026-10-03T00:00:00.000Z");
      assert.strictEqual(web?.state, "merged");
      assert.strictEqual(web?.mergedAt, "2026-10-21T00:00:00.000Z");
      assert.strictEqual(web?.key, "github.com/acme/web#1");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("sends every non-dismissed pull request once and never their titles", () =>
  Effect.gen(function* () {
    yield* insertThread({
      id: "t",
      links: [
        // Linked in September, merged inside the window.
        link({
          number: 1,
          snapshot: snapshot({
            state: "merged",
            mergedAt: "2026-10-09T00:00:00.000Z",
          }),
        }),
        // Merged before the window.
        link({
          number: 2,
          snapshot: snapshot({ state: "merged", mergedAt: "2026-09-09T00:00:00.000Z" }),
        }),
        // Merged with no date, linked inside the window.
        link({
          number: 3,
          linkedAt: "2026-10-09T00:00:00.000Z",
          snapshot: snapshot({ state: "merged", mergedAt: null }),
        }),
        // Only linked, never synced, nothing dates it.
        link({ number: 4, linkedAt: "2026-10-09T00:00:00.000Z" }),
        // Opened inside the window and never synced.
        link({ number: 5, source: "created", linkedAt: "2026-10-09T00:00:00.000Z" }),
        // Opened after the window ended.
        link({ number: 6, source: "created", linkedAt: "2026-11-01T00:00:00.000Z" }),
        link({ number: 7, source: "stack-dismissed", linkedAt: "2026-10-09T00:00:00.000Z" }),
      ],
    });
    // A pull request linked only from a subagent thread is still real work.
    yield* insertThread({
      id: "child",
      lineage: { parentThreadId: "t", relationshipToParent: "subagent" },
      links: [link({ number: 8, source: "created", linkedAt: "2026-10-09T00:00:00.000Z" })],
    });
    yield* insertThread({
      id: "gone",
      deleted: true,
      links: [link({ number: 9, source: "created", linkedAt: "2026-10-09T00:00:00.000Z" })],
    });

    const summary = yield* readWorkSummary(input);
    assert.deepStrictEqual(
      summary.pullRequests.map((row) => row.number).toSorted((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 8],
    );
    assert.notInclude(JSON.stringify(summary), "Private title");
    assert.notInclude(JSON.stringify(summary), "private-branch");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects empty, reversed, and oversized windows", () =>
  Effect.gen(function* () {
    for (const bad of [
      { sinceTime: UNTIL, untilTime: SINCE },
      { sinceTime: SINCE, untilTime: SINCE },
      { sinceTime: "yesterday", untilTime: UNTIL },
      { sinceTime: "2024-01-01T00:00:00.000Z", untilTime: UNTIL },
    ]) {
      const exit = yield* Effect.exit(readWorkSummary(bad));
      assert.isTrue(Exit.isFailure(exit));
    }
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
