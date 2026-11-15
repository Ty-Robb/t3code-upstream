import type { WorkShareInput } from "@t3tools/client-runtime/work-share";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * The summary the share dialog is open for. The dashboard and the command palette both set it, so
 * the dialog is mounted once at the app root.
 */
export const workShareDialogInputAtom = Atom.make<WorkShareInput | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("work-share:dialog-input"),
);

export function openWorkShareDialog(input: WorkShareInput): void {
  appAtomRegistry.set(workShareDialogInputAtom, input);
}

/** Clearly-labelled sample data: previewable and exportable, never postable. */
export const SAMPLE_WORK_SHARE_INPUT: WorkShareInput = {
  source: "sample",
  periodLabel: "Last 7 days",
  projectLabel: "Sample project",
  counts: { pullRequestsOpened: 12, pullRequestsMerged: 9, threadsWorkedOn: 31 },
  insights: { mergeRatePercent: 75, tokensPerMergedPullRequest: 41_000 },
};
