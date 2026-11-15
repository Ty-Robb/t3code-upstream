/**
 * Usage-aware routing policy shared by clients (new-thread defaults) and the server (agent
 * launches, usage-limit fallback). Missing, unsupported, failed, stale or past-reset readings
 * never count as capacity; accounts that share credentials share quota.
 */
import {
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";

/** Matches the picker's "needs refresh" threshold and the shared five-minute refresh throttle. */
export const USAGE_READING_FRESH_MS = 5 * 60_000;
/** Below this, an account is about to stop and routing more work onto it only moves the stop. */
const MIN_ROUTING_REMAINING_PERCENT = 5;
/**
 * A fallback costs the provider's native session, so shorter cooldowns are waited out and
 * reset auto-resume handles them instead.
 */
export const MIN_FALLBACK_RESET_DELAY_MS = 15 * 60_000;

export type AccountCapacity =
  | {
      readonly status: "available";
      readonly remainingPercent: number;
      /** The applicable window with the least capacity left. */
      readonly window: ServerProviderUsageWindow;
      /** Windows this provider normally reports that this reading lacks; never read as unused. */
      readonly unreported: ReadonlyArray<"session" | "weekly">;
    }
  | { readonly status: "exhausted"; readonly window: ServerProviderUsageWindow }
  | {
      readonly status: "unknown";
      readonly reason: "unsupported" | "probeFailed" | "missing" | "stale";
    };

/**
 * Model-specific allowances apply only to their models. Claude's extra-usage spend budget is paid
 * usage beyond the subscription, so it neither blocks nor adds routing headroom.
 */
function windowAppliesToModel(
  driver: ServerProvider["driver"],
  window: ServerProviderUsageWindow,
  model: string,
): boolean {
  switch (driver) {
    case "claudeAgent": {
      if (window.id === "monthly_spend") return false;
      const scope = /^seven_day_([a-z0-9]+)/.exec(window.id)?.[1];
      return scope === undefined || model.toLowerCase().includes(scope);
    }
    case "cursor":
      if (window.id === "autoPercentUsed") return /^(auto|default|grok|composer)/.test(model);
      return window.id !== "apiPercentUsed" || !/^(auto|default|grok|composer)/.test(model);
    case "antigravity": {
      const family = model.match(/^(gemini|claude|gpt)-/)?.[1];
      const pool = window.id.match(/^(gemini|claude|gpt|3p)-/)?.[1];
      return (
        pool === undefined ||
        family === undefined ||
        pool === family ||
        (pool === "3p" && (family === "claude" || family === "gpt"))
      );
    }
    case "opencode":
      return !window.id.startsWith("go_") || model.startsWith("opencode-go/");
    default:
      return true;
  }
}

/**
 * Claude and Codex subscriptions meter both a session and a weekly window. A reading missing one,
 * such as a hub window that reported no utilization, ranks below complete readings.
 */
const EXPECTED_WINDOW_KINDS: Readonly<Record<string, ReadonlyArray<"session" | "weekly">>> = {
  claudeAgent: ["session", "weekly"],
  codex: ["session", "weekly"],
};

const remaining = (window: ServerProviderUsageWindow) =>
  Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));

export function assessAccountCapacity(
  provider: ServerProvider,
  model: string,
  now: number,
): AccountCapacity {
  const limits = provider.usageLimits;
  if (limits?.unavailable?.reason === "unsupported") {
    return { status: "unknown", reason: "unsupported" };
  }
  // A failed probe keeps the last good bars for display, but they are no longer a reading.
  if (limits?.unavailable?.reason === "probeFailed") {
    return { status: "unknown", reason: "probeFailed" };
  }
  const windows = (limits?.windows ?? []).filter((window) =>
    windowAppliesToModel(provider.driver, window, model),
  );
  if (!limits || windows.length === 0) return { status: "unknown", reason: "missing" };
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > USAGE_READING_FRESH_MS) {
    return { status: "unknown", reason: "stale" };
  }
  // An exhausted window without a usable reset stays exhausted; one past its reset is stale.
  const exhausted = windows.find(
    (window) =>
      window.usedPercent >= 100 &&
      (!window.resetsAt ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) > now),
  );
  if (exhausted) return { status: "exhausted", window: exhausted };
  if (windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now)) {
    return { status: "unknown", reason: "stale" };
  }
  const binding = windows.reduce((low, window) =>
    remaining(window) < remaining(low) ? window : low,
  );
  const unreported = (EXPECTED_WINDOW_KINDS[provider.driver] ?? []).filter(
    (kind) => !windows.some((window) => window.kind === kind),
  );
  return { status: "available", remainingPercent: remaining(binding), window: binding, unreported };
}

/** Instances signed in with the same credentials draw on one quota. */
function usageAccountKey(provider: Pick<ServerProvider, "instanceId" | "usageLimits">) {
  return provider.usageLimits?.credentialFingerprint ?? provider.instanceId;
}

export function providerAccountName(provider: ServerProvider): string {
  return provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.instanceId;
}

function describeCapacity(capacity: AccountCapacity): string {
  switch (capacity.status) {
    case "available":
      return `${capacity.window.label} ${capacity.remainingPercent}% left${capacity.unreported.map((kind) => `, ${kind} not reported`).join("")}`;
    case "exhausted":
      return `${capacity.window.label} limit reached`;
    case "unknown":
      return {
        unsupported: "limits not reported",
        probeFailed: "limit check failed",
        missing: "no usage reading",
        stale: "usage reading out of date",
      }[capacity.reason];
  }
}

export interface UsageRoutedSelection {
  readonly selection: ModelSelection;
  readonly provider: ServerProvider;
  readonly starred: boolean;
  /** One sentence a user can read to see why this account and model were chosen. */
  readonly reason: string;
}

interface Candidate {
  readonly provider: ServerProvider;
  readonly model: ServerProvider["models"][number];
  readonly capacity: Extract<AccountCapacity, { status: "available" }>;
  readonly live: number;
  readonly order: number;
}

function usableProvider(
  provider: ServerProvider,
  settings: ServerSettings | undefined,
  projectId: ProjectId | null,
) {
  return (
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    (!settings || resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId))
  );
}

/**
 * Options carry over only for the same model slug, where they mean the same thing; another model
 * starts at its provider defaults. Fast modes spend quota faster, so routing keeps normal speed.
 */
function routedOptions(base: ModelSelection | null, model: string) {
  if (!base?.options || base.model !== model) return undefined;
  const options = base.options.filter((option) => option.id !== "fastMode");
  return options.length > 0 ? options : undefined;
}

const score = (candidate: Candidate) => candidate.capacity.remainingPercent / (1 + candidate.live);

// Complete readings outrank partial ones, then headroom per running thread, then star order.
function rank(candidate: Candidate): readonly number[] {
  return [candidate.capacity.unreported.length === 0 ? 1 : 0, score(candidate), -candidate.order];
}

function best(candidates: readonly Candidate[]): Candidate | undefined {
  const outranks = (a: Candidate, b: Candidate) => {
    const [left, right] = [rank(a), rank(b)];
    const index = left.findIndex((value, i) => value !== right[i]);
    return index !== -1 && left[index]! > right[index]!;
  };
  return candidates.reduce<Candidate | undefined>(
    (top, candidate) => (top === undefined || outranks(candidate, top) ? candidate : top),
    undefined,
  );
}

function liveNote(live: number) {
  return live === 0 ? "" : ` · ${live} other ${live === 1 ? "thread" : "threads"} running`;
}

/**
 * Starred models with fresh, available capacity come first; their exact account is the starred
 * instance. Only when none qualifies does any other usable account with a fresh available reading
 * take the work, and the reason says so. Returns null when no account has verifiable capacity,
 * so callers keep their own default rather than guessing.
 */
export function chooseUsageRoutedSelection(input: {
  readonly favorites: NonNullable<ServerSettings["favorites"]>;
  readonly providers: readonly ServerProvider[];
  /** The selection the caller would otherwise use; supplies the model and effort to prefer. */
  readonly base: ModelSelection | null;
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
  /** Accounts known to be limited, such as the one a fallback is leaving. */
  readonly excludedInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /** Restricts the choice, such as to instances that can run a delegated task. */
  readonly allowedInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /** Running threads per instance; they share the quota but nothing is reserved for them. */
  readonly liveThreadsByInstance?: ReadonlyMap<ProviderInstanceId, number>;
}): UsageRoutedSelection | null {
  const projectId = input.projectId ?? null;
  const excludedAccounts = new Set(
    input.providers
      .filter((provider) => input.excludedInstanceIds?.has(provider.instanceId))
      .map(usageAccountKey),
  );
  for (const id of input.excludedInstanceIds ?? []) excludedAccounts.add(id);
  const liveByAccount = new Map<string, number>();
  for (const provider of input.providers) {
    const key = usageAccountKey(provider);
    liveByAccount.set(
      key,
      (liveByAccount.get(key) ?? 0) + (input.liveThreadsByInstance?.get(provider.instanceId) ?? 0),
    );
  }
  const candidate = (
    provider: ServerProvider,
    slug: string,
    order: number,
  ): Candidate | AccountCapacity | "unusable" => {
    const model = provider.models.find((entry) => entry.slug === slug);
    if (
      !model ||
      excludedAccounts.has(usageAccountKey(provider)) ||
      (input.allowedInstanceIds !== undefined &&
        !input.allowedInstanceIds.has(provider.instanceId)) ||
      !usableProvider(provider, input.settings, projectId) ||
      provider.updateRequiredModels?.some((gated) => gated.slug === slug)
    ) {
      return "unusable";
    }
    const capacity = assessAccountCapacity(provider, slug, input.now);
    if (
      capacity.status !== "available" ||
      capacity.remainingPercent < MIN_ROUTING_REMAINING_PERCENT
    ) {
      return capacity;
    }
    return {
      provider,
      model,
      capacity,
      live: liveByAccount.get(usageAccountKey(provider)) ?? 0,
      order,
    };
  };
  const toSelection = (chosen: Candidate): ModelSelection => {
    const options = routedOptions(input.base, chosen.model.slug);
    return {
      instanceId: chosen.provider.instanceId,
      model: chosen.model.slug,
      ...(options ? { options } : {}),
    };
  };

  const starredNotes: string[] = [];
  const starred: Candidate[] = [];
  input.favorites.forEach((favorite, order) => {
    const provider = input.providers.find((entry) => entry.instanceId === favorite.provider);
    if (!provider) return;
    const result = candidate(provider, favorite.model, order);
    if (result === "unusable") return;
    if ("provider" in result) starred.push(result);
    else starredNotes.push(`${providerAccountName(provider)} ${describeCapacity(result)}`);
  });
  const chosenStarred = best(starred);
  if (chosenStarred) {
    return {
      selection: toSelection(chosenStarred),
      provider: chosenStarred.provider,
      starred: true,
      reason: `Starred ${chosenStarred.model.name} on ${providerAccountName(chosenStarred.provider)}: ${describeCapacity(chosenStarred.capacity)}${liveNote(chosenStarred.live)}.`,
    };
  }

  const starredKeys = new Set(input.favorites.map((entry) => `${entry.provider}:${entry.model}`));
  const others: Candidate[] = [];
  input.providers.forEach((provider, order) => {
    const hidden = new Set(
      input.settings?.providerModelPreferences?.[provider.instanceId]?.hiddenModels,
    );
    const slug =
      input.base &&
      provider.models.some((model) => model.slug === input.base?.model) &&
      !hidden.has(input.base.model)
        ? input.base.model
        : (
            provider.models.find((model) => model.isDefault && !hidden.has(model.slug)) ??
            provider.models.find((model) => !model.isLegacy && !hidden.has(model.slug))
          )?.slug;
    if (!slug || starredKeys.has(`${provider.instanceId}:${slug}`)) return;
    const result = candidate(provider, slug, order);
    if (result !== "unusable" && "provider" in result) others.push(result);
  });
  const chosen = best(others);
  if (!chosen) return null;
  const why =
    input.favorites.length === 0
      ? "No models are starred"
      : `No starred model has fresh capacity${starredNotes.length > 0 ? ` (${starredNotes.slice(0, 3).join("; ")})` : ""}`;
  return {
    selection: toSelection(chosen),
    provider: chosen.provider,
    starred: false,
    reason: `${why}. Using ${chosen.model.name} on ${providerAccountName(chosen.provider)}: ${describeCapacity(chosen.capacity)}${liveNote(chosen.live)}.`,
  };
}

/**
 * The account switch usage-aware routing made for a thread's latest run, if any: a usage-limit
 * continuation that runs on another instance than the run it continues. Clients show it with a
 * way back; a later run, such as one after the user switched back, clears it.
 */
export function latestUsageLimitSwitch(
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "status" | "startedAt" | "modelSelection" | "usageLimitContinuationOfRunId"
    >
  >,
): { readonly from: ModelSelection; readonly to: ModelSelection } | null {
  const latest = runs.reduce<(typeof runs)[number] | undefined>(
    (top, run) =>
      run.status === "cancelled" && run.startedAt === null
        ? top
        : top === undefined || run.ordinal > top.ordinal
          ? run
          : top,
    undefined,
  );
  if (latest?.usageLimitContinuationOfRunId === undefined) return null;
  const source = runs.find((run) => run.id === latest.usageLimitContinuationOfRunId);
  if (!source || source.modelSelection.instanceId === latest.modelSelection.instanceId) return null;
  return { from: source.modelSelection, to: latest.modelSelection };
}
