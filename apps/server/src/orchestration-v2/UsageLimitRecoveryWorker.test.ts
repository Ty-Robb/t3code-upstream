import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageRouting from "../usage/UsageRouting.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitFallbackEligible, limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(UsageRouting.UsageRouting)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("usage-aware fallback", () => {
  // Stopped just now; the account reopens in two hours.
  const limited = failedThread(0, -2 * HOUR_MS);

  it.each([
    ["a limited run", limited, true],
    ["a short cooldown", failedThread(0, -10 * 60 * 1000), false],
    [
      "a run already armed for its reset",
      {
        ...limited,
        limitRecovery: {
          runId: limited.latestRunId!,
          resetAt: limited.usageLimitResetAt!,
          autoResume: true,
        },
      },
      false,
    ],
    ["a snoozed thread", { ...limited, snoozedUntil: DateTime.makeUnsafe(nowMs + HOUR_MS) }, false],
    ["a settled thread", { ...limited, settledOverride: "settled" as const }, false],
  ] as const)("is eligible for %s: %s", (_name, thread, eligible) => {
    assert.equal(limitFallbackEligible(thread, nowMs), eligible);
  });

  const fallback: UsageRouting.UsageLimitFallback = {
    selection: { instanceId: ProviderInstanceId.make("claude-02"), model: "claude-opus-5-5" },
    provider: undefined as never,
    starred: true,
    reason: "Starred Opus 5.5 on Claude 02: Weekly 25% left.",
    from: undefined,
    attempt: 0,
  };

  const sweepWith = (
    choices: ReadonlyArray<UsageRouting.UsageLimitFallback | "in_flight" | null>,
    thread = limited,
  ) =>
    Effect.gen(function* () {
      const dispatched: Array<unknown> = [];
      const armed: Array<unknown> = [];
      let sweep: Effect.Effect<void> = Effect.void;
      let choice = 0;
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Scheduler.Scheduler, {
              register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
                Effect.gen(function* () {
                  const context = yield* Effect.context<R>();
                  sweep = work.pipe(Effect.provideContext(context), Effect.orDie);
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () => Effect.succeed([thread]),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                }) as never,
            }),
            Layer.mock(UsageRouting.UsageRouting)({
              chooseFallback: () => Effect.succeed(choices[choice++] ?? null),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              autoArmLimitRecovery: (input) =>
                Effect.sync(() => {
                  armed.push(input.limitRecovery);
                }) as never,
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                autoResumeLimitedThreads: false,
                snoozeLimitedThreads: false,
                usageAwareRouting: true,
              } as never),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        for (let tick = 0; tick < choices.length + 1; tick++) yield* sweep;
      }).pipe(Effect.provide(layer));
      return { dispatched, armed };
    });

  it.effect("dispatches one fallback per limited run, then waits for the reset", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { dispatched, armed } = yield* sweepWith([fallback]);
      assert.lengthOf(dispatched, 1);
      const command = dispatched[0] as OrchestrationV2Command;
      assert(command.type === "message.dispatch");
      assert.equal(command.usageLimitContinuationOfRunId, limited.latestRunId);
      assert.deepEqual(command.modelSelection, fallback.selection);
      assert.include(command.text, fallback.reason);
      // The thread still reads as limited, as after a rejected switch: the next sweep arms it.
      assert.deepEqual(armed, [
        {
          runId: limited.latestRunId,
          resetAt: limited.usageLimitResetAt,
          autoResume: true,
          snooze: false,
        },
      ]);
    }),
  );

  it.effect("resumes at the reset when no account has verified capacity", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { dispatched, armed } = yield* sweepWith([null]);
      assert.lengthOf(dispatched, 0);
      assert.equal(armed.length > 0, true);
    }),
  );

  it.effect("leaves a continuation that is waiting to start alone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const { dispatched, armed } = yield* sweepWith(["in_flight", "in_flight"]);
      assert.lengthOf(dispatched, 0);
      assert.lengthOf(armed, 0);
    }),
  );
});
