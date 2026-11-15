import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  type WorkSummary,
  type WorkSummaryInput,
  type WorkSummaryTotals,
  type WorkSummaryWindow,
} from "@t3tools/contracts";
import { resolveWorkSummaryAccess } from "@t3tools/client-runtime/state/work-summary-access";
import { deriveWorkSummaryTotals } from "@t3tools/shared/workSummary";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";

export interface EnvironmentWorkStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: WorkSummary | null;
  /** What was asked of this environment; refreshing replays exactly this. */
  readonly input: WorkSummaryInput | null;
}

/** Environments and projects the dashboard reads; null means everything connected. */
export interface WorkScope {
  readonly environmentIds: ReadonlySet<EnvironmentId> | null;
  /** `environmentId:projectId` keys. Project ids only mean something inside their environment. */
  readonly projectKeys: ReadonlySet<string> | null;
}

export function workProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export interface WorkView {
  readonly environments: readonly EnvironmentWorkStatus[];
  readonly totals: WorkSummaryTotals;
  readonly isPending: boolean;
  /** A read is in flight, including a refresh that still shows the previous figures. */
  readonly isReading: boolean;
}

interface WorkSelection {
  readonly environments: readonly EnvironmentWorkStatus[];
  readonly summaries: readonly WorkSummary[];
}

function environmentInput(
  window: WorkSummaryWindow,
  environmentId: EnvironmentId,
  projectKeys: readonly string[] | null,
): WorkSummaryInput | null {
  if (projectKeys === null) return { sinceTime: window.sinceTime, untilTime: window.untilTime };
  const prefix = `${environmentId}:`;
  const projectIds = projectKeys
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length) as ProjectId);
  // Nothing chosen here: asking would only read zeros for projects the viewer excluded.
  if (projectIds.length === 0) return null;
  return { sinceTime: window.sinceTime, untilTime: window.untilTime, projectIds };
}

const workByWindowAtom = Atom.family((selectionKey: string) =>
  Atom.make((get): WorkSelection => {
    const selection = JSON.parse(selectionKey) as {
      readonly window: WorkSummaryWindow;
      readonly environmentIds: readonly EnvironmentId[] | null;
      readonly projectKeys: readonly string[] | null;
    };
    const presentations = get(environmentPresentations.presentationsAtom);
    const environments: EnvironmentWorkStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      if (selection.environmentIds !== null && !selection.environmentIds.includes(environmentId)) {
        continue;
      }
      const base = {
        environmentId,
        label: presentation.entry.target.label,
        isConnected: presentation.connection.phase === "connected",
      };
      const input = environmentInput(selection.window, environmentId, selection.projectKeys);
      if (input === null) continue;
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveWorkSummaryAccess({
        connectionPhase: presentation.connection.phase,
        session: AsyncResult.getOrElse(sessionResult, () => null),
        hasSessionError: sessionResult._tag === "Failure",
      });
      if (!access.canReadWork) {
        environments.push({
          ...base,
          isPending: access.isPending,
          error: access.error,
          summary: null,
          input: null,
        });
        continue;
      }
      const result = get(serverEnvironment.workSummary({ environmentId, input }));
      environments.push({
        ...base,
        isPending: result.waiting,
        error:
          result._tag === "Failure"
            ? "This environment could not report work. Its server may predate Work, or the read failed."
            : null,
        // A failed refresh keeps the previous figures, and the error note says they may be old.
        summary: Option.getOrNull(AsyncResult.value(result)),
        input,
      });
    }
    return {
      environments,
      summaries: environments.flatMap(({ summary }) => (summary === null ? [] : [summary])),
    };
  }).pipe(Atom.withLabel(`web-work-summary:${selectionKey}`)),
);

function selectionKeyOf(window: WorkSummaryWindow, scope: WorkScope): string {
  return JSON.stringify({
    window,
    environmentIds: scope.environmentIds === null ? null : [...scope.environmentIds].sort(),
    projectKeys: scope.projectKeys === null ? null : [...scope.projectKeys].sort(),
  });
}

const NO_WORK_ATOM = Atom.make<WorkSelection>({ environments: [], summaries: [] }).pipe(
  Atom.withLabel("web-work-summary:disabled"),
);

/** Re-reads every environment in the selection now, bypassing the short query cache. */
export function refreshWorkSummary(window: WorkSummaryWindow, scope: WorkScope): void {
  const { environments } = appAtomRegistry.get(workByWindowAtom(selectionKeyOf(window, scope)));
  for (const { environmentId, input } of environments) {
    if (input !== null) {
      appAtomRegistry.refresh(serverEnvironment.workSummary({ environmentId, input }));
    }
  }
}

/** While `enabled` is false nothing is subscribed, so a closed Work tab never reads the database. */
export function useWorkSummary(
  window: WorkSummaryWindow,
  scope: WorkScope,
  enabled: boolean,
): WorkView {
  const { environments, summaries } = useAtomValue(
    enabled ? workByWindowAtom(selectionKeyOf(window, scope)) : NO_WORK_ATOM,
  );
  // Staleness is judged at the time the figures were read, which keeps this render pure.
  const readAt = summaries.reduce(
    (latest, summary) => Math.max(latest, Date.parse(summary.readAt)),
    0,
  );
  const totals = deriveWorkSummaryTotals({
    window,
    summaries,
    environmentsTotal: environments.length,
    now: readAt,
  });
  return {
    environments,
    totals,
    isPending: summaries.length === 0 && environments.some((environment) => environment.isPending),
    isReading: environments.some((environment) => environment.isPending),
  };
}
