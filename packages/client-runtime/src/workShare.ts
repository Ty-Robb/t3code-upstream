/**
 * Presentation model for the shareable work card. The dashboard owns the numbers (period, filters,
 * PR deduplication, verification); this module only turns an already-aggregated summary into the
 * card, the post text and the privacy preview, so a client never recomputes accomplishments.
 */

/** The authoritative repository the optional support call-to-action points at. */
export const WORK_SHARE_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

export interface WorkShareInput {
  /** `sample` is clearly-labelled fixture data: it can be previewed and exported, never posted. */
  readonly source: "sample" | "dashboard";
  /** Human period label from the dashboard, e.g. "Last 7 days". */
  readonly periodLabel: string;
  /** Project name, or null for an all-projects summary. Hidden unless the user includes it. */
  readonly projectLabel: string | null;
  /** Whether the dashboard knows the project is public. Unknown is treated as private. */
  readonly projectIsPublic?: boolean;
  /** Counts the dashboard has verified. Omit a count it cannot stand behind. */
  readonly counts: {
    readonly pullRequestsOpened?: number;
    readonly pullRequestsMerged?: number;
    readonly threadsWorkedOn?: number;
  };
  /** Environments that contributed to `counts`. Partial coverage is stated on the card. */
  readonly coverage?: {
    readonly environmentsReporting: number;
    readonly environmentsTotal: number;
  };
  /**
   * Ratios the dashboard computed once over the same window and filters as `counts`. This module
   * never derives them, and omits any it is not given or cannot stand behind.
   */
  readonly insights?: {
    /** Whole percent of PRs opened in the window that merged. */
    readonly mergeRatePercent?: number;
    /** Tokens spent per merged PR. Only meaningful when at least one PR merged. */
    readonly tokensPerMergedPullRequest?: number;
  };
}

export interface WorkShareOptions {
  readonly includeProject: boolean;
  readonly includeSupportLink: boolean;
  /** Token usage reveals the user's setup and spend, so it is opt-in. */
  readonly includeTokens: boolean;
}

export const DEFAULT_WORK_SHARE_OPTIONS: WorkShareOptions = {
  includeProject: false,
  includeSupportLink: false,
  includeTokens: false,
};

export interface WorkShareStat {
  readonly label: string;
  readonly value: number;
}

export interface WorkShareCard {
  readonly source: WorkShareInput["source"];
  readonly periodLabel: string;
  /** Present only when the user included it and it is safe to print. */
  readonly projectLabel: string | null;
  readonly stats: ReadonlyArray<WorkShareStat>;
  /** Short ratio phrases shown under the stats, e.g. "75% of opened PRs merged". */
  readonly insights: ReadonlyArray<string>;
  /** Set when only some environments reported, e.g. "Based on 2 of 3 environments". */
  readonly coverageNote: string | null;
  readonly shareText: string;
  readonly fileName: string;
  /** Everything the card, image and text reveal, for the privacy preview. */
  readonly disclosed: ReadonlyArray<string>;
  /** Everything held back, for the privacy preview. */
  readonly withheld: ReadonlyArray<string>;
  /** False for sample data or a summary whose counts are all absent or zero. */
  readonly canShare: boolean;
}

const MAX_LABEL = 48;

// A label that looks like a path, URL or email is never printed, even when the user opts in.
const UNSAFE_LABEL = /[\\/~]|:\/\/|@|^[a-z]:/i;

function cleanText(value: string | null | undefined): string | null {
  const text = value?.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (!text) return null;
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

/** Project names get the path filter too; a period label like "11/01–11/07" must not. */
function cleanProjectLabel(value: string | null | undefined): string | null {
  const text = cleanText(value);
  return text && !UNSAFE_LABEL.test(text) ? text : null;
}

function validCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * Stats keep "opened" and "merged" apart: a creation count must never read as shipped work.
 * Nothing is derived here, so a count the dashboard did not supply is simply absent.
 */
function buildStats(counts: WorkShareInput["counts"]): WorkShareStat[] {
  const stats: WorkShareStat[] = [];
  if (validCount(counts.pullRequestsOpened)) {
    stats.push({
      label: plural(counts.pullRequestsOpened, "PR opened", "PRs opened"),
      value: counts.pullRequestsOpened,
    });
  }
  if (validCount(counts.pullRequestsMerged)) {
    stats.push({
      label: plural(counts.pullRequestsMerged, "PR merged", "PRs merged"),
      value: counts.pullRequestsMerged,
    });
  }
  if (validCount(counts.threadsWorkedOn)) {
    stats.push({
      label: plural(counts.threadsWorkedOn, "thread worked on", "threads worked on"),
      value: counts.threadsWorkedOn,
    });
  }
  return stats;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** Whether the tokens opt-in would add anything, so the UI only offers it when it does. */
export function canIncludeTokens(input: WorkShareInput): boolean {
  const tokens = input.insights?.tokensPerMergedPullRequest;
  return (
    tokens !== undefined &&
    Number.isFinite(tokens) &&
    tokens > 0 &&
    (input.counts.pullRequestsMerged ?? 0) > 0
  );
}

function buildInsights(input: WorkShareInput, options: WorkShareOptions): string[] {
  const { insights } = input;
  const out: string[] = [];
  const rate = insights?.mergeRatePercent;
  if (rate !== undefined && Number.isFinite(rate) && rate >= 0 && rate <= 100) {
    out.push(`${Math.round(rate)}% of opened PRs merged`);
  }
  const tokens = insights?.tokensPerMergedPullRequest;
  if (options.includeTokens && tokens !== undefined && canIncludeTokens(input)) {
    out.push(`${formatCompact(tokens)} tokens per merged PR`);
  }
  return out;
}

function buildCoverageNote(coverage: WorkShareInput["coverage"]): string | null {
  if (!coverage) return null;
  const { environmentsReporting: reporting, environmentsTotal: total } = coverage;
  if (!Number.isSafeInteger(reporting) || !Number.isSafeInteger(total)) return null;
  if (total <= 0 || reporting < 0 || reporting >= total) return null;
  return `Based on ${reporting} of ${total} environments`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildWorkShareCard(
  input: WorkShareInput,
  options: WorkShareOptions = DEFAULT_WORK_SHARE_OPTIONS,
): WorkShareCard {
  const periodLabel = cleanText(input.periodLabel) ?? "Recent work";
  const stats = buildStats(input.counts);
  const insights = buildInsights(input, options);
  const coverageNote = buildCoverageNote(input.coverage);
  const safeProject = cleanProjectLabel(input.projectLabel);
  const includeProject = options.includeProject && safeProject !== null;
  const projectLabel = includeProject ? safeProject : null;

  const withheld = [
    "Prompts, messages and code",
    "Your file paths and repository URLs",
    "Credentials and tokens",
  ];
  const disclosed = [
    `Period: ${periodLabel}`,
    ...stats.map((s) => `${s.value} ${s.label}`),
    ...insights,
    ...(coverageNote ? [coverageNote] : []),
  ];
  if (!options.includeTokens && canIncludeTokens(input)) {
    withheld.push("Token usage");
  }
  if (projectLabel) {
    disclosed.push(
      input.projectIsPublic === true
        ? `Project name: ${projectLabel}`
        : `Project name: ${projectLabel} (not confirmed public)`,
    );
  } else if (input.projectLabel) {
    withheld.push(
      options.includeProject ? "Project name (looks like a path or address)" : "Project name",
    );
  }
  if (options.includeSupportLink) disclosed.push(`Link: ${WORK_SHARE_REPOSITORY_URL}`);

  const summary = stats.map((s) => `${s.value} ${s.label}`).join(", ");
  const scope = projectLabel ? ` on ${projectLabel}` : "";
  const lines = [
    `${periodLabel}${scope} with T3 Code${summary ? `: ${summary}` : ""}.`,
    ...(insights.length ? [`${insights.join(", ")}.`] : []),
    ...(coverageNote ? [`${coverageNote}.`] : []),
    ...(options.includeSupportLink ? [WORK_SHARE_REPOSITORY_URL] : []),
  ];

  return {
    source: input.source,
    periodLabel,
    projectLabel,
    stats,
    insights,
    coverageNote,
    shareText: lines.join("\n"),
    fileName: `t3-code-work-${slug(periodLabel) || "summary"}.png`,
    disclosed,
    withheld,
    canShare: input.source === "dashboard" && stats.some((stat) => stat.value > 0),
  };
}

/** The X composer opens pre-filled; the user reviews and presses Post themselves. */
export function buildXComposeUrl(text: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text }).toString()}`;
}

/**
 * The slice of the work summary dashboard's totals a card needs. Declared structurally so this
 * module compiles before, and independently of, the dashboard's contract.
 */
export interface WorkSummaryTotalsForShare {
  readonly coverage: {
    readonly environmentsReporting: number;
    readonly environmentsTotal: number;
  };
  readonly threadsWithCompletedRuns: number;
  readonly pullRequests: {
    readonly opened: number;
    readonly merged: number;
    readonly openedOutcome: { readonly merged: number; readonly unknown: number };
  };
}

/**
 * Maps the dashboard's verified totals onto the card. The merge rate is withheld while any opened
 * PR was never read from the host, because counting those as unmerged would understate it.
 * Totals carry no project name, so none is added unless the caller supplies one.
 */
export function workShareInputFromTotals(
  totals: WorkSummaryTotalsForShare,
  context: { readonly periodLabel: string; readonly projectLabel?: string | null },
): WorkShareInput {
  const { opened, merged, openedOutcome } = totals.pullRequests;
  const rateKnown = opened > 0 && openedOutcome.unknown === 0;
  return {
    source: "dashboard",
    periodLabel: context.periodLabel,
    projectLabel: context.projectLabel ?? null,
    coverage: totals.coverage,
    counts: {
      pullRequestsOpened: opened,
      pullRequestsMerged: merged,
      threadsWorkedOn: totals.threadsWithCompletedRuns,
    },
    ...(rateKnown
      ? { insights: { mergeRatePercent: Math.round((openedOutcome.merged / opened) * 100) } }
      : {}),
  };
}
