import type { WorkShareInput } from "@t3tools/client-runtime/work-share";
import type { WorkSummaryTotals } from "@t3tools/contracts";

/**
 * Maps verified dashboard totals into the share card's input. A ratio is passed only when every
 * opened pull request has a known outcome, since an unread one could have merged or not.
 */
export function workShareInputFromTotals(
  totals: WorkSummaryTotals,
  context: { readonly periodLabel: string; readonly projectLabel: string | null },
): WorkShareInput {
  const { pullRequests } = totals;
  const rateIsKnown = pullRequests.opened > 0 && pullRequests.openedOutcome.unknown === 0;
  return {
    source: "dashboard",
    periodLabel: context.periodLabel,
    projectLabel: context.projectLabel,
    counts: {
      pullRequestsOpened: pullRequests.opened,
      pullRequestsMerged: pullRequests.merged,
      threadsWorkedOn: totals.threadsWithCompletedRuns,
    },
    coverage: totals.coverage,
    ...(rateIsKnown
      ? {
          insights: {
            mergeRatePercent: Math.round(
              (pullRequests.openedOutcome.merged / pullRequests.opened) * 100,
            ),
          },
        }
      : {}),
  };
}
