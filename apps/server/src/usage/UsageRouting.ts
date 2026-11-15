import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import {
  assessAccountCapacity,
  chooseUsageRoutedSelection,
  USAGE_READING_FRESH_MS,
  type UsageRoutedSelection,
} from "@t3tools/shared/usageRouting";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * One owner for usage-aware routing on the server: agent launches, delegated tasks and
 * usage-limit fallback all route through it, with the policy in `@t3tools/shared/usageRouting`
 * that clients use for new-thread defaults.
 */
export class UsageRouting extends Context.Service<
  UsageRouting,
  {
    /**
     * A routed selection for work that has no explicit model, or null when routing is off or no
     * account has verifiable capacity. `base` is what the caller would otherwise use.
     */
    readonly chooseForLaunch: (input: {
      readonly projectId: ProjectId;
      readonly base: ModelSelection | null;
      /** Only these instances may be chosen, such as those that can run a delegated task. */
      readonly allowedInstanceIds?: ReadonlySet<ProviderInstanceId>;
    }) => Effect.Effect<UsageRoutedSelection | null>;
    /**
     * Another account for a thread whose run stopped on a usage limit. Every account in the
     * thread's current chain of limited continuations is excluded, so each is tried once.
     * `in_flight` means a continuation of this run is already waiting to start.
     */
    readonly chooseFallback: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<UsageLimitFallback | "in_flight" | null>;
  }
>()("t3/usage/UsageRouting") {}

export interface UsageLimitFallback extends UsageRoutedSelection {
  readonly from: ServerProvider | undefined;
  /** Earlier continuations of this run cancelled before they started, such as by a restart. */
  readonly attempt: number;
}

// A refresh that hangs must not stall the recovery sweep or an agent launch.
const REFRESH_TIMEOUT = "20 seconds";

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // A probe that keeps failing must not cost every launch a refresh.
  const lastRefreshAttemptMs = new Map<ProviderInstanceId, number>();

  /**
   * Stale or failed readings are refreshed before a decision, at most once per freshness window
   * per account. Unsupported accounts never are.
   */
  const freshProviders = Effect.fn("UsageRouting.freshProviders")(function* () {
    const providers = yield* providerRegistry.getProviders;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const stale = providers.filter((provider) => {
      if (
        !provider.enabled ||
        nowMs - (lastRefreshAttemptMs.get(provider.instanceId) ?? -Infinity) <
          USAGE_READING_FRESH_MS
      )
        return false;
      const model = provider.models[0]?.slug;
      if (model === undefined) return false;
      const capacity = assessAccountCapacity(provider, model, nowMs);
      return (
        capacity.status === "unknown" &&
        (capacity.reason === "stale" || capacity.reason === "probeFailed")
      );
    });
    if (stale.length === 0) return providers;
    for (const provider of stale) lastRefreshAttemptMs.set(provider.instanceId, nowMs);
    yield* Effect.forEach(
      stale,
      (provider) =>
        instances.getInstance(provider.instanceId).pipe(
          Effect.flatMap((instance) => instance?.snapshot.refreshUsage ?? Effect.void),
          Effect.timeout(REFRESH_TIMEOUT),
          Effect.ignoreCause({ log: true }),
        ),
      { concurrency: 4, discard: true },
    );
    return yield* providerRegistry.getProviders;
  });

  const liveThreads = projections
    .countLiveThreadsByProviderInstance()
    .pipe(Effect.orElseSucceed((): ReadonlyMap<ProviderInstanceId, number> => new Map()));

  const chooseForLaunch: UsageRouting["Service"]["chooseForLaunch"] = Effect.fn(
    "UsageRouting.chooseForLaunch",
  )(function* (input) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings?.usageAwareRouting) return null;
    const providers = yield* freshProviders();
    return chooseUsageRoutedSelection({
      favorites: settings.favorites ?? [],
      providers,
      base: input.base,
      settings,
      projectId: input.projectId,
      ...(input.allowedInstanceIds === undefined
        ? {}
        : { allowedInstanceIds: input.allowedInstanceIds }),
      liveThreadsByInstance: yield* liveThreads,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
  });

  const chooseFallback: UsageRouting["Service"]["chooseFallback"] = Effect.fn(
    "UsageRouting.chooseFallback",
  )(function* (input) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!settings?.usageAwareRouting) return null;
    const shell = yield* projections
      .getThreadShell(input.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const records = yield* projections
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || records === null) return null;
    const runsById = new Map(records.runs.map((run) => [run.id, run]));
    const source = runsById.get(input.runId);
    if (source === undefined) return null;
    const continuations = records.runs.filter(
      (run) => run.usageLimitContinuationOfRunId === source.id,
    );
    if (continuations.some((run) => run.status !== "cancelled")) return "in_flight";
    // Walk back through limited continuations: each account in this stretch already hit a limit.
    const limited = new Set<ProviderInstanceId>();
    for (
      let run: typeof source | undefined = source;
      run !== undefined && !limited.has(run.providerInstanceId);
      run =
        run.usageLimitContinuationOfRunId === undefined
          ? undefined
          : runsById.get(run.usageLimitContinuationOfRunId)
    ) {
      limited.add(run.providerInstanceId);
    }
    const providers = yield* freshProviders();
    const routed = chooseUsageRoutedSelection({
      favorites: settings.favorites ?? [],
      providers,
      base: source.modelSelection,
      settings,
      projectId: shell.projectId,
      excludedInstanceIds: limited,
      liveThreadsByInstance: yield* liveThreads,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    if (routed === null) return null;
    return {
      ...routed,
      from: providers.find((provider) => provider.instanceId === source.providerInstanceId),
      attempt: continuations.length,
    };
  });

  return UsageRouting.of({ chooseForLaunch, chooseFallback });
});

export const layer = Layer.effect(UsageRouting, make);

/** Routing switched off, for tests that build agent tools without a provider registry. */
export const layerTest = Layer.succeed(
  UsageRouting,
  UsageRouting.of({
    chooseForLaunch: Effect.fn("UsageRouting.chooseForLaunch")(function* () {
      return yield* Effect.succeed(null);
    }),
    chooseFallback: Effect.fn("UsageRouting.chooseFallback")(function* () {
      return yield* Effect.succeed(null);
    }),
  }),
);
