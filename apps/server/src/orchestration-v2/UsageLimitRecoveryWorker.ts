import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import {
  MIN_FALLBACK_RESET_DELAY_MS,
  providerAccountName,
  type UsageRoutedSelection,
} from "@t3tools/shared/usageRouting";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageRouting from "../usage/UsageRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/**
 * Usage-aware routing moves a limited run to another account once, before the failure is armed
 * for its reset. Short cooldowns are waited out, since a switch loses the native session.
 */
export function limitFallbackEligible(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  nowMs: number,
): boolean {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return false;
  // Once armed, the thread waits for its reset; the fallback is not retried every sweep.
  if (
    thread.limitRecovery?.runId === thread.latestRunId &&
    thread.limitRecovery.resetAt === thread.usageLimitResetAt
  )
    return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const stoppedMs = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  return (
    Number.isFinite(resetMs) &&
    resetMs > nowMs &&
    resetMs - stoppedMs >= MIN_FALLBACK_RESET_DELAY_MS
  );
}

export function limitFallbackCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  fallback: UsageRoutedSelection & {
    readonly from: UsageRouting.UsageLimitFallback["from"];
    readonly attempt: number;
  },
): OrchestrationV2Command | null {
  if (!thread.latestRunId || !thread.usageLimitResetAt) return null;
  const identity = `${thread.id}:${thread.latestRunId}:${Date.parse(thread.usageLimitResetAt)}:${fallback.attempt}`;
  const from = fallback.from ? providerAccountName(fallback.from) : "The previous account";
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-fallback:${identity}`),
    messageId: MessageId.make(`limit-fallback:${identity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    modelSelection: fallback.selection,
    // Model-facing: the new session gets a handoff, not the old session's native tool state.
    text: [
      `${from} reached a usage limit that resets at ${thread.usageLimitResetAt}. Usage-aware routing moved this thread to another account. ${fallback.reason}`,
      "The conversation so far was carried over to this account, but tool and process state from the previous session may not have been. Check the current state before acting, do not repeat commands or changes that already completed, and continue where you left off.",
    ].join("\n\n"),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const routing = yield* UsageRouting.UsageRouting;
  // One fallback attempt per limited run and process: a rejected switch falls through to the
  // reset on the next sweep instead of repeating. A restart may try once more.
  const attemptedFallbacks = new Set<string>();
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    // With no account to move to, routed work resumes at the reset rather than stopping.
    const autoResume = preferences.autoResumeLimitedThreads || preferences.usageAwareRouting;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume,
      snooze: preferences.snoozeLimitedThreads,
    });
    let acted = false;
    for (const thread of candidates) {
      if (
        preferences.usageAwareRouting &&
        thread.latestRunId &&
        !attemptedFallbacks.has(`${thread.id}:${thread.latestRunId}`) &&
        limitFallbackEligible(thread, nowMs)
      ) {
        const fallback = yield* routing.chooseFallback({
          threadId: thread.id,
          runId: thread.latestRunId,
        });
        if (fallback === "in_flight") continue;
        const fallbackCommand = fallback === null ? null : limitFallbackCommand(thread, fallback);
        if (fallbackCommand !== null) {
          acted = true;
          attemptedFallbacks.add(`${thread.id}:${thread.latestRunId}`);
          yield* threads.dispatch(fallbackCommand).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.limit-recovery.fallback-failed", {
                threadId: thread.id,
                cause,
              }),
            ),
          );
          continue;
        }
      }
      const command = limitRecoveryCommand(
        thread,
        autoResume,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
