import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageRouting from "./UsageRouting.ts";

const nowMs = Date.parse("2026-11-15T03:00:00.000Z");
const fresh = "2026-11-15T02:59:00.000Z";
const stale = "2026-11-15T02:00:00.000Z";
const opus = "claude-opus-5-5";
const threadId = ThreadId.make("thread:limited");
const [one, two, three] = ["claude-01", "claude-02", "claude-03"].map((id) =>
  ProviderInstanceId.make(id),
) as [ProviderInstanceId, ProviderInstanceId, ProviderInstanceId];

const claude = (
  instanceId: ProviderInstanceId,
  checkedAt: string,
  weekly = 50,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [{ slug: opus, name: "Opus 5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt,
    windows: [
      { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 - weekly },
    ],
  },
});

const run = (
  id: string,
  instanceId: ProviderInstanceId,
  extra: { status?: string; continues?: string; startedAt?: null } = {},
) => ({
  id: RunId.make(id),
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: opus },
  status: extra.status ?? "failed",
  startedAt: extra.startedAt === null ? null : nowMs,
  ...(extra.continues === undefined
    ? {}
    : { usageLimitContinuationOfRunId: RunId.make(extra.continues) }),
});

const choose = (input: {
  readonly runs: ReadonlyArray<ReturnType<typeof run>>;
  readonly runId: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly routing?: boolean;
  readonly refreshed?: ReadonlyArray<ServerProvider>;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const refreshes: Array<ProviderInstanceId> = [];
    let providers = input.providers;
    const layer = UsageRouting.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              usageAwareRouting: input.routing ?? true,
              favorites: [one, two, three].map((provider) => ({ provider, model: opus })),
              providerInstances: Object.fromEntries(
                [one, two, three].map((id) => [
                  id,
                  { driver: ProviderDriverKind.make("claudeAgent"), enabled: true, config: {} },
                ]),
              ),
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) =>
              Effect.succeed({
                snapshot: {
                  refreshUsage: Effect.sync(() => {
                    refreshes.push(instanceId);
                    providers = input.refreshed ?? providers;
                  }),
                },
              } as never),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed({ projectId: ProjectId.make("project") } as never),
            getThreadRecords: () => Effect.succeed({ runs: input.runs } as never),
            countLiveThreadsByProviderInstance: () => Effect.succeed(new Map()),
          }),
        ),
      ),
    );
    const result = yield* UsageRouting.UsageRouting.pipe(
      Effect.flatMap((routing) =>
        routing.chooseFallback({ threadId, runId: RunId.make(input.runId) }),
      ),
      Effect.provide(layer),
    );
    return { result, refreshes };
  });

describe("UsageRouting.chooseFallback", () => {
  it.effect("skips every account already limited in this stretch of continuations", () =>
    Effect.gen(function* () {
      const { result } = yield* choose({
        runs: [run("run:1", one), run("run:2", two, { continues: "run:1" })],
        runId: "run:2",
        providers: [claude(one, fresh, 90), claude(two, fresh, 90), claude(three, fresh, 20)],
      });
      assert(result !== null && result !== "in_flight");
      assert.equal(result.selection.instanceId, three);
      assert.equal(result.from?.instanceId, two);
      assert.equal(result.attempt, 0);
    }),
  );

  it.effect("waits while a continuation of the run has not started", () =>
    Effect.gen(function* () {
      const { result } = yield* choose({
        runs: [run("run:1", one), run("run:2", two, { continues: "run:1", status: "queued" })],
        runId: "run:1",
        providers: [claude(two, fresh)],
      });
      assert.equal(result, "in_flight");
    }),
  );

  // Restart recovery cancels a continuation its provider never accepted; the next try needs
  // a new command id, or the receipt of the cancelled one would swallow it.
  it.effect("counts continuations a restart cancelled before they started", () =>
    Effect.gen(function* () {
      const { result } = yield* choose({
        runs: [
          run("run:1", one),
          run("run:2", two, { continues: "run:1", status: "cancelled", startedAt: null }),
        ],
        runId: "run:1",
        providers: [claude(two, fresh)],
      });
      assert(result !== null && result !== "in_flight");
      assert.equal(result.attempt, 1);
    }),
  );

  it.effect("refreshes stale readings before deciding, and never guesses from them", () =>
    Effect.gen(function* () {
      const stuck = yield* choose({
        runs: [run("run:1", one)],
        runId: "run:1",
        providers: [claude(one, fresh), claude(two, stale)],
      });
      assert.isNull(stuck.result);
      assert.deepEqual(stuck.refreshes, [two]);
      const refreshed = yield* choose({
        runs: [run("run:1", one)],
        runId: "run:1",
        providers: [claude(one, fresh), claude(two, stale)],
        refreshed: [claude(one, fresh), claude(two, fresh)],
      });
      assert(refreshed.result !== null && refreshed.result !== "in_flight");
      assert.equal(refreshed.result.selection.instanceId, two);
    }),
  );

  it.effect("probes a failing account at most once per freshness window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const refreshes: Array<ProviderInstanceId> = [];
      const failed = {
        ...claude(two, fresh),
        usageLimits: {
          ...claude(two, fresh).usageLimits!,
          unavailable: { reason: "probeFailed" as const },
        },
      };
      const layer = UsageRouting.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, usageAwareRouting: true }),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([failed]),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (instanceId) =>
                Effect.succeed({
                  snapshot: { refreshUsage: Effect.sync(() => refreshes.push(instanceId)) },
                } as never),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              countLiveThreadsByProviderInstance: () => Effect.succeed(new Map()),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const routing = yield* UsageRouting.UsageRouting;
        const launch = routing.chooseForLaunch({
          projectId: ProjectId.make("project"),
          base: null,
        });
        assert.isNull(yield* launch);
        assert.isNull(yield* launch);
        assert.deepEqual(refreshes, [two]);
        yield* TestClock.adjust("6 minutes");
        yield* launch;
        assert.deepEqual(refreshes, [two, two]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does nothing with routing off", () =>
    Effect.gen(function* () {
      const { result, refreshes } = yield* choose({
        runs: [run("run:1", one)],
        runId: "run:1",
        providers: [claude(two, stale)],
        routing: false,
      });
      assert.isNull(result);
      assert.lengthOf(refreshes, 0);
    }),
  );
});
