import type { EnvironmentId, WorkSummaryTotals } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";
import { ChevronDownIcon, InfoIcon, Share2Icon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { EnvironmentWorkStatus } from "../../state/workSummary";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

export interface WorkProjectOption {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly title: string;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

function Figure({
  label,
  value,
  definition,
  loading,
  large = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly definition: string;
  readonly loading: boolean;
  readonly large?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        <Popover>
          <PopoverTrigger
            openOnHover
            render={<InlineButton tone="muted" />}
            aria-label={`How ${label.toLowerCase()} is counted`}
          >
            <InfoIcon className="size-3" aria-hidden />
          </PopoverTrigger>
          <PopoverPopup side="top" tooltipStyle>
            {definition}
          </PopoverPopup>
        </Popover>
      </span>
      <span
        className={cn(
          "font-semibold text-foreground tabular-nums transition-opacity",
          large ? "text-4xl" : "text-xl",
          loading && "opacity-40 delay-150",
        )}
      >
        {formatCount(value)}
      </span>
    </div>
  );
}

/** The four states an opened pull request can be in now; they always add up to the opened total. */
function OpenedOutcome({ totals }: { readonly totals: WorkSummaryTotals["pullRequests"] }) {
  const { openedOutcome: outcome, opened } = totals;
  if (opened === 0) return null;
  const rows = [
    { label: "Merged", value: outcome.merged },
    { label: "Still open", value: outcome.open },
    { label: "Closed without merging", value: outcome.closedUnmerged },
    { label: "Status never read", value: outcome.unknown },
  ].filter((row) => row.value > 0);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs text-muted-foreground">
        Where the {formatCount(opened)} opened stand now
      </h3>
      <div
        role="img"
        aria-label={rows.map((row) => `${row.label}: ${row.value}`).join(", ")}
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {rows.map((row, index) => (
          <div
            key={row.label}
            className={cn("h-full", index === 0 ? "bg-foreground" : "bg-foreground/40")}
            style={{ width: `${(row.value / opened) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        {rows.map((row) => (
          <li key={row.label}>
            <span className="text-foreground">{formatCount(row.value)}</span>{" "}
            {row.label.toLowerCase()}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Names what the totals above cannot say, so a quiet number is never mistaken for a complete one. */
function evidenceNotes(
  totals: WorkSummaryTotals,
  environments: readonly EnvironmentWorkStatus[],
): string[] {
  const { coverage, pullRequests } = totals;
  const notes: string[] = [];
  for (const environment of environments) {
    if (environment.error !== null && !environment.isPending) {
      notes.push(`${environment.label}: ${environment.error}`);
    }
  }
  if (coverage.environmentsReporting < coverage.environmentsTotal) {
    notes.push(
      `Totals cover ${coverage.environmentsReporting} of ${plural(coverage.environmentsTotal, "environment")}.`,
    );
  }
  if (pullRequests.mergedWithoutDate > 0) {
    notes.push(
      `${plural(pullRequests.mergedWithoutDate, "merged pull request")} first linked in this period ${pullRequests.mergedWithoutDate === 1 ? "has" : "have"} no merge date from the host, so none is counted as merged here.`,
    );
  }
  if (pullRequests.openedOutcome.unknown > 0) {
    notes.push(
      `${plural(pullRequests.openedOutcome.unknown, "opened pull request")} ${pullRequests.openedOutcome.unknown === 1 ? "was" : "were"} never read from the host, so ${pullRequests.openedOutcome.unknown === 1 ? "its" : "their"} status is unknown.`,
    );
  }
  if (pullRequests.staleStatus > 0) {
    notes.push(
      `${plural(pullRequests.staleStatus, "pull request")} still ${pullRequests.staleStatus === 1 ? "shows" : "show"} open from a status read over 2 days ago and may have merged since.`,
    );
  }
  return notes;
}

export function WorkSummaryView({
  totals,
  environments,
  isPending,
  isReading,
  hasEnvironments,
  onShare,
}: {
  readonly totals: WorkSummaryTotals;
  readonly environments: readonly EnvironmentWorkStatus[];
  readonly isPending: boolean;
  readonly isReading: boolean;
  readonly hasEnvironments: boolean;
  readonly onShare: () => void;
}) {
  if (!hasEnvironments) {
    return <p className="text-sm text-muted-foreground">Select an environment to see work.</p>;
  }
  if (isPending) {
    return (
      <div aria-busy className="flex flex-col gap-6">
        <Skeleton className="h-20 w-64" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  const { pullRequests } = totals;
  const empty =
    totals.coverage.environmentsReporting > 0 &&
    totals.runsCompleted === 0 &&
    totals.threadsSettled === 0 &&
    pullRequests.opened === 0 &&
    pullRequests.merged === 0;
  const notes = evidenceNotes(totals, environments);

  return (
    <div aria-busy={isReading} className="flex flex-col gap-8">
      {empty ? (
        <p className="text-sm text-muted-foreground">
          No completed work was recorded in this period.
        </p>
      ) : null}

      <section aria-label="Pull requests" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Pull requests</h2>
          <Button variant="outline" size="xs" disabled={isReading} onClick={onShare}>
            <Share2Icon aria-hidden />
            Share
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <Figure
            large
            loading={isReading}
            label="Merged"
            value={pullRequests.merged}
            definition="Distinct pull requests linked to threads that the host reports as merged, with a merge date inside this period. A pull request linked from several threads counts once."
          />
          <Figure
            large
            loading={isReading}
            label="Opened in T3"
            value={pullRequests.opened}
            definition="Distinct pull requests T3 saw an agent or the Create PR flow open in this period. A pull request you only linked to a thread is not counted as opened."
          />
        </div>
        <OpenedOutcome totals={pullRequests} />
      </section>

      <section aria-label="Agent work" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">Agent work</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <Figure
            loading={isReading}
            label="Runs completed"
            value={totals.runsCompleted}
            definition="Agent runs that finished with status completed in this period. Failed, cancelled, interrupted and still-running runs are not counted."
          />
          <Figure
            loading={isReading}
            label="Threads worked on"
            value={totals.threadsWithCompletedRuns}
            definition="Distinct threads with at least one completed run in this period. Subagent threads and side chats are not counted separately; their parent thread's runs are."
          />
          <Figure
            loading={isReading}
            label="Threads settled"
            value={totals.threadsSettled}
            definition="Threads marked settled in this period, by you or automatically, that you have not set back to active."
          />
        </div>
      </section>

      <section
        aria-label="About these numbers"
        className="flex flex-col gap-1 text-xs text-muted-foreground"
      >
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>
          Counts come from what each environment recorded: threads and pull requests it still holds,
          read from the host when last synced. They say nothing about effort, time or money saved.
        </p>
      </section>
    </div>
  );
}

export function WorkProjectFilter({
  projects,
  selectedKeys,
  onChange,
}: {
  readonly projects: readonly WorkProjectOption[];
  readonly selectedKeys: ReadonlySet<string> | null;
  readonly onChange: (keys: ReadonlySet<string> | null) => void;
}) {
  const allSelected = selectedKeys === null;
  const chosen = allSelected
    ? projects
    : projects.filter((project) => selectedKeys.has(project.key));
  const label = allSelected
    ? "All projects"
    : chosen.length === 0
      ? "No projects"
      : chosen.length === 1
        ? chosen[0]!.title
        : `${chosen.length} projects`;
  const environmentLabels = new Set(projects.map((project) => project.environmentLabel));
  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/work-project min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/work-project:opacity-100 group-data-popup-open/work-project:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? null : new Set())}
        >
          All projects
        </MenuCheckboxItem>
        <MenuSeparator />
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.key}
            checked={allSelected || selectedKeys.has(project.key)}
            closeOnClick={false}
            onCheckedChange={(checked) => {
              const next = new Set(chosen.map((entry) => entry.key));
              if (checked) next.add(project.key);
              else next.delete(project.key);
              onChange(next.size === projects.length ? null : next);
            }}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
              {environmentLabels.size > 1 ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {project.environmentLabel}
                </span>
              ) : null}
            </span>
          </MenuCheckboxItem>
        ))}
        {projects.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No projects.</p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
