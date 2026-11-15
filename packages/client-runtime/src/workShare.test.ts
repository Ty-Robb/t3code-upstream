import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkShareCard,
  buildXComposeUrl,
  workShareInputFromTotals,
  WORK_SHARE_REPOSITORY_URL,
  type WorkShareInput,
} from "./workShare.ts";

const dashboard: WorkShareInput = {
  source: "dashboard",
  periodLabel: "Last 7 days",
  projectLabel: "acme-app",
  counts: { pullRequestsOpened: 5, pullRequestsMerged: 3 },
};

describe("buildWorkShareCard", () => {
  it("hides the project and the repository link until the user opts in", () => {
    const card = buildWorkShareCard(dashboard);
    expect(card.projectLabel).toBeNull();
    expect(card.shareText).toBe("Last 7 days with T3 Code: 5 PRs opened, 3 PRs merged.");
    expect(card.withheld).toContain("Project name");
    expect(card.shareText).not.toContain("acme-app");
    expect(card.shareText).not.toContain(WORK_SHARE_REPOSITORY_URL);
  });

  it("includes the project and link only when chosen, and discloses them", () => {
    const card = buildWorkShareCard(dashboard, {
      includeProject: true,
      includeSupportLink: true,
      includeTokens: false,
    });
    expect(card.shareText).toBe(
      `Last 7 days on acme-app with T3 Code: 5 PRs opened, 3 PRs merged.\n${WORK_SHARE_REPOSITORY_URL}`,
    );
    expect(card.disclosed).toContain("Project name: acme-app (not confirmed public)");
  });

  it.each([
    "/Users/me/secret-repo",
    "C:\\work\\repo",
    "~/code/x",
    "git@host:org/repo",
    "https://x",
  ])("never prints a path-like project label even when opted in: %s", (projectLabel) => {
    const card = buildWorkShareCard(
      { ...dashboard, projectLabel },
      { includeProject: true, includeSupportLink: false, includeTokens: false },
    );
    expect(card.projectLabel).toBeNull();
    expect(card.shareText).not.toContain(projectLabel);
  });

  it("keeps a date-range period label that contains slashes", () => {
    expect(buildWorkShareCard({ ...dashboard, periodLabel: "11/01–11/07" }).periodLabel).toBe(
      "11/01–11/07",
    );
  });

  it("keeps opened and merged apart and does not invent absent or invalid counts", () => {
    const card = buildWorkShareCard({
      ...dashboard,
      counts: { pullRequestsOpened: 1, pullRequestsMerged: -2, threadsWorkedOn: Number.NaN },
    });
    expect(card.stats).toEqual([{ label: "PR opened", value: 1 }]);
    expect(card.shareText).not.toMatch(/merged|shipped/);
  });

  it("shows the merge rate by default and tokens per merged PR only on opt-in", () => {
    const input: WorkShareInput = {
      ...dashboard,
      insights: { mergeRatePercent: 60, tokensPerMergedPullRequest: 41_200 },
    };
    const byDefault = buildWorkShareCard(input);
    expect(byDefault.insights).toEqual(["60% of opened PRs merged"]);
    expect(byDefault.withheld).toContain("Token usage");
    expect(byDefault.shareText).not.toContain("tokens");

    const optedIn = buildWorkShareCard(input, {
      includeProject: false,
      includeSupportLink: false,
      includeTokens: true,
    });
    expect(optedIn.insights).toEqual(["60% of opened PRs merged", "41.2K tokens per merged PR"]);
    expect(optedIn.shareText).toContain("41.2K tokens per merged PR.");
  });

  it("drops ratios it can't stand behind instead of showing zero or infinity", () => {
    const options = { includeProject: false, includeSupportLink: false, includeTokens: true };
    const noMerges = buildWorkShareCard(
      {
        ...dashboard,
        counts: { pullRequestsOpened: 4, pullRequestsMerged: 0 },
        insights: { mergeRatePercent: Number.NaN, tokensPerMergedPullRequest: 5_000 },
      },
      options,
    );
    expect(noMerges.insights).toEqual([]);
    const outOfRange = buildWorkShareCard(
      { ...dashboard, insights: { mergeRatePercent: 140, tokensPerMergedPullRequest: Infinity } },
      options,
    );
    expect(outOfRange.insights).toEqual([]);
  });

  it("states partial environment coverage in the card, text and privacy list", () => {
    const partial = buildWorkShareCard({
      ...dashboard,
      coverage: { environmentsReporting: 2, environmentsTotal: 3 },
    });
    expect(partial.coverageNote).toBe("Based on 2 of 3 environments");
    expect(partial.shareText).toContain("Based on 2 of 3 environments.");
    expect(partial.disclosed).toContain("Based on 2 of 3 environments");
    for (const coverage of [
      { environmentsReporting: 3, environmentsTotal: 3 },
      { environmentsReporting: 0, environmentsTotal: 0 },
    ]) {
      expect(buildWorkShareCard({ ...dashboard, coverage }).coverageNote).toBeNull();
    }
  });

  it("refuses to share sample data or an empty summary", () => {
    expect(buildWorkShareCard({ ...dashboard, source: "sample" }).canShare).toBe(false);
    expect(buildWorkShareCard({ ...dashboard, counts: {} }).canShare).toBe(false);
    expect(
      buildWorkShareCard({ ...dashboard, counts: { pullRequestsOpened: 0, pullRequestsMerged: 0 } })
        .canShare,
    ).toBe(false);
    expect(buildWorkShareCard(dashboard).canShare).toBe(true);
  });
});

describe("buildXComposeUrl", () => {
  it("encodes the text into the X compose intent", () => {
    const url = new URL(buildXComposeUrl("5 PRs & more\nhttps://a.b"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe("5 PRs & more\nhttps://a.b");
  });
});

describe("workShareInputFromTotals", () => {
  const totals = {
    coverage: { environmentsReporting: 1, environmentsTotal: 2 },
    threadsWithCompletedRuns: 7,
    pullRequests: { opened: 8, merged: 7, openedOutcome: { merged: 6, unknown: 0 } },
  };

  it("maps verified totals, derives the cohort merge rate and keeps coverage", () => {
    const card = buildWorkShareCard(
      workShareInputFromTotals(totals, { periodLabel: "Last 7 days" }),
    );
    expect(card.stats.map((s) => `${s.value} ${s.label}`)).toEqual([
      "8 PRs opened",
      "7 PRs merged",
      "7 threads worked on",
    ]);
    expect(card.insights).toEqual(["75% of opened PRs merged"]);
    expect(card.coverageNote).toBe("Based on 1 of 2 environments");
    expect(card.canShare).toBe(true);
    expect(card.projectLabel).toBeNull();
  });

  it("gives an unshareable card for a period with no activity", () => {
    const empty = {
      coverage: { environmentsReporting: 1, environmentsTotal: 1 },
      threadsWithCompletedRuns: 0,
      pullRequests: { opened: 0, merged: 0, openedOutcome: { merged: 0, unknown: 0 } },
    };
    const card = buildWorkShareCard(workShareInputFromTotals(empty, { periodLabel: "x" }));
    expect(card.canShare).toBe(false);
    expect(card.insights).toEqual([]);
  });

  it("withholds the merge rate while any opened PR was never read from the host", () => {
    const withUnknown = {
      ...totals,
      pullRequests: { ...totals.pullRequests, openedOutcome: { merged: 6, unknown: 1 } },
    };
    expect(
      buildWorkShareCard(workShareInputFromTotals(withUnknown, { periodLabel: "x" })).insights,
    ).toEqual([]);
  });
});
