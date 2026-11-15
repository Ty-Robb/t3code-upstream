import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

/**
 * Work totals count the threads and pull requests orchestration read already exposes, so the
 * grant is checked against each destination environment rather than assumed from the first.
 */
export function resolveWorkSummaryAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly session: SessionGrantInput | null;
  readonly hasSessionError: boolean;
}) {
  if (input.hasSessionError) {
    return {
      canReadWork: false,
      isPending: false,
      error: "Could not check this connection's access to threads.",
    };
  }
  if (input.session === null) {
    const isPending =
      input.connectionPhase === "connected" ||
      input.connectionPhase === "connecting" ||
      input.connectionPhase === "reconnecting";
    return {
      canReadWork: false,
      isPending,
      error: isPending ? null : "This environment is not connected.",
    };
  }
  const canReadWork = sessionGrantsScope(input.session, AuthOrchestrationReadScope);
  return {
    canReadWork,
    isPending: false,
    error: canReadWork ? null : "This connection does not have access to threads.",
  };
}
