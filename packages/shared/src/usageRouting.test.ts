import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  assessAccountCapacity,
  chooseUsageRoutedSelection,
  latestUsageLimitSwitch,
} from "./usageRouting.ts";

const now = Date.parse("2026-11-15T03:00:00.000Z");
const fresh = "2026-11-15T02:58:00.000Z";
const later = "2026-11-15T08:00:00.000Z";

const claude01 = ProviderInstanceId.make("claude-01");
const claude02 = ProviderInstanceId.make("claude-02");
const codex = ProviderInstanceId.make("codex");
const NAMES: Record<string, string> = {
  [claude01]: "Claude 01",
  [claude02]: "Claude 02",
  [codex]: "Codex",
};

function limits(
  session: number | null,
  weekly: number | null,
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return {
    checkedAt: fresh,
    windows: [
      ...(session === null
        ? []
        : [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "Session",
              usedPercent: 100 - session,
              resetsAt: later,
            },
          ]),
      ...(weekly === null
        ? []
        : [
            {
              id: "seven_day",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 100 - weekly,
              resetsAt: later,
            },
          ]),
    ],
    ...overrides,
  };
}

function provider(
  instanceId: ProviderInstanceId,
  usageLimits: ServerProviderUsageLimits | undefined,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  const driver = instanceId === codex ? "codex" : "claudeAgent";
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    displayName: NAMES[instanceId],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    models:
      driver === "codex"
        ? [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null }]
        : [
            {
              slug: "claude-opus-5-5",
              name: "Opus 5.5",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
            { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, capabilities: null },
          ],
    slashCommands: [],
    skills: [],
    ...(usageLimits ? { usageLimits } : {}),
    ...overrides,
  };
}

const star = (instanceId: ProviderInstanceId, model: string) => ({ provider: instanceId, model });
const opus = "claude-opus-5-5";

describe("assessAccountCapacity", () => {
  it.each([
    ["no reading", undefined, { status: "unknown", reason: "missing" }],
    [
      "unsupported",
      { checkedAt: fresh, windows: [], unavailable: { reason: "unsupported" as const } },
      { status: "unknown", reason: "unsupported" },
    ],
    [
      "a failed probe that kept its last bars",
      limits(90, 90, { unavailable: { reason: "probeFailed" } }),
      { status: "unknown", reason: "probeFailed" },
    ],
    [
      "a reading older than five minutes",
      limits(90, 90, { checkedAt: "2026-11-15T02:54:00.000Z" }),
      { status: "unknown", reason: "stale" },
    ],
    [
      "a window past its reset",
      {
        ...limits(90, 90),
        windows: limits(90, 90).windows.map((window) => ({
          ...window,
          resetsAt: "2026-11-15T02:59:00.000Z",
        })),
      },
      { status: "unknown", reason: "stale" },
    ],
  ] as const)("never counts %s as capacity", (_name, usageLimits, expected) => {
    expect(assessAccountCapacity(provider(claude01, usageLimits), opus, now)).toEqual(expected);
  });

  it("binds on the applicable window with the least left, including a model allowance", () => {
    const reading = limits(91, 65);
    const opusWeekly = {
      id: "seven_day_opus",
      kind: "weekly" as const,
      label: "Weekly · Opus",
      usedPercent: 80,
      resetsAt: later,
    };
    const scoped = provider(claude01, { ...reading, windows: [...reading.windows, opusWeekly] });
    expect(assessAccountCapacity(scoped, opus, now)).toMatchObject({
      unreported: [],
      status: "available",
      remainingPercent: 20,
      window: { id: "seven_day_opus" },
    });
    expect(assessAccountCapacity(scoped, "claude-sonnet-5-5", now)).toMatchObject({
      remainingPercent: 65,
    });
  });
});

describe("assessAccountCapacity spend and plan windows", () => {
  it("ignores Claude's extra-usage spend budget", () => {
    const reading = limits(80, 60);
    const spent = {
      ...reading,
      windows: [
        ...reading.windows,
        { id: "monthly_spend", kind: "monthly" as const, label: "Monthly spend", usedPercent: 100 },
      ],
    };
    expect(assessAccountCapacity(provider(claude01, spent), opus, now)).toMatchObject({
      status: "available",
      remainingPercent: 60,
    });
  });

  it("counts Cursor's monthly plan usage as its quota", () => {
    const cursor = provider(
      codex,
      {
        checkedAt: fresh,
        windows: [
          { id: "apiPercentUsed", kind: "monthly", label: "API", usedPercent: 70, resetsAt: later },
        ],
      },
      { driver: ProviderDriverKind.make("cursor") },
    );
    expect(assessAccountCapacity(cursor, "claude-opus-5-5", now)).toMatchObject({
      status: "available",
      remainingPercent: 30,
    });
  });
});

describe("chooseUsageRoutedSelection", () => {
  // The starred models report no limits, as Codex did when this policy was written.
  const unsupported = {
    checkedAt: fresh,
    windows: [],
    unavailable: { reason: "unsupported" as const },
  };

  it("prefers the starred account with the most verified headroom", () => {
    const routed = chooseUsageRoutedSelection({
      favorites: [star(claude02, opus), star(claude01, opus)],
      providers: [provider(claude01, limits(91, 65)), provider(claude02, limits(80, 25))],
      base: null,
      now,
    });
    expect(routed?.selection).toEqual({ instanceId: claude01, model: opus });
    expect(routed?.reason).toBe("Starred Opus 5.5 on Claude 01: Weekly 65% left.");
  });

  // The launch-time readings: Claude 02 reported a weekly window but no session window.
  it("ranks a reading without its session window below a complete one", () => {
    const providers = [provider(claude01, limits(91, 65)), provider(claude02, limits(null, 95))];
    const routed = chooseUsageRoutedSelection({
      favorites: [star(claude02, opus), star(claude01, opus)],
      providers,
      base: null,
      now,
    });
    expect(routed?.selection.instanceId).toBe(claude01);
    expect(
      chooseUsageRoutedSelection({
        favorites: [star(claude02, opus)],
        providers,
        base: null,
        now,
      })?.reason,
    ).toBe("Starred Opus 5.5 on Claude 02: Weekly 95% left, session not reported.");
  });

  it("explains the exception when no starred model has a verifiable reading", () => {
    const routed = chooseUsageRoutedSelection({
      favorites: [star(codex, "gpt-6.1-sol")],
      providers: [
        provider(codex, unsupported),
        provider(claude01, limits(91, 65)),
        provider(claude02, limits(null, 25)),
      ],
      base: { instanceId: codex, model: "gpt-6.1-sol" },
      now,
    });
    expect(routed?.starred).toBe(false);
    expect(routed?.selection).toEqual({ instanceId: claude01, model: opus });
    expect(routed?.reason).toBe(
      "No starred model has fresh capacity (Codex limits not reported). Using Opus 5.5 on Claude 01: Weekly 65% left.",
    );
  });

  it("returns null rather than guessing when nothing has a fresh reading", () => {
    expect(
      chooseUsageRoutedSelection({
        favorites: [star(codex, "gpt-6.1-sol")],
        providers: [
          provider(codex, unsupported),
          provider(claude01, limits(91, 65, { checkedAt: "2026-11-15T01:00:00.000Z" })),
          provider(claude02, undefined),
        ],
        base: null,
        now,
      }),
    ).toBeNull();
  });

  it("skips exhausted, nearly exhausted, excluded and same-credential accounts", () => {
    const shared = { credentialFingerprint: "acct-1" };
    expect(
      chooseUsageRoutedSelection({
        favorites: [star(claude01, opus), star(claude02, opus)],
        providers: [
          provider(claude01, limits(0, 65, shared)),
          provider(claude02, limits(90, 90, shared)),
          provider(codex, limits(3, 90)),
        ],
        base: null,
        excludedInstanceIds: new Set([claude01]),
        now,
      }),
    ).toBeNull();
  });

  it("weighs running threads that draw on the same quota", () => {
    const routed = chooseUsageRoutedSelection({
      favorites: [star(claude01, opus), star(claude02, opus)],
      providers: [provider(claude01, limits(90, 60)), provider(claude02, limits(90, 40))],
      base: null,
      liveThreadsByInstance: new Map([[claude01, 2]]),
      now,
    });
    expect(routed?.selection.instanceId).toBe(claude02);
  });

  it("keeps the requested effort on the same model but drops fast mode", () => {
    const routed = chooseUsageRoutedSelection({
      favorites: [star(claude02, opus)],
      providers: [provider(claude01, limits(0, 65)), provider(claude02, limits(80, 25))],
      base: {
        instanceId: claude01,
        model: opus,
        options: [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      now,
    });
    expect(routed?.selection).toEqual({
      instanceId: claude02,
      model: opus,
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("ignores accounts that are signed out or disabled", () => {
    expect(
      chooseUsageRoutedSelection({
        favorites: [star(claude01, opus), star(claude02, opus)],
        providers: [
          provider(claude01, limits(90, 90), { auth: { status: "unauthenticated" } }),
          provider(claude02, limits(90, 90), { enabled: false }),
        ],
        base: null,
        now,
      }),
    ).toBeNull();
  });
});

describe("latestUsageLimitSwitch", () => {
  const on = (instanceId: ProviderInstanceId) => ({ instanceId, model: opus });
  const run = (
    ordinal: number,
    instanceId: ProviderInstanceId,
    extra: { continues?: number; status?: "cancelled" | "running"; startedAt?: null } = {},
  ) => ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    status: extra.status ?? ("failed" as const),
    startedAt: extra.startedAt === null ? null : DateTime.makeUnsafe(now),
    modelSelection: on(instanceId),
    ...(extra.continues === undefined
      ? {}
      : { usageLimitContinuationOfRunId: RunId.make(`run:${extra.continues}`) }),
  });

  it.each([
    [
      "a fallback onto another account",
      [run(1, claude01), run(2, claude02, { continues: 1, status: "running" })],
      { from: on(claude01), to: on(claude02) },
    ],
    ["a resume on the same account", [run(1, claude01), run(2, claude01, { continues: 1 })], null],
    [
      "a later run after switching back",
      [run(1, claude01), run(2, claude02, { continues: 1 }), run(3, claude01)],
      null,
    ],
    [
      "a fallback a restart cancelled before it started",
      [run(1, claude01), run(2, claude02, { continues: 1, status: "cancelled", startedAt: null })],
      null,
    ],
  ] as const)("reports %s", (_name, runs, expected) => {
    expect(latestUsageLimitSwitch(runs)).toEqual(expected);
  });
});
