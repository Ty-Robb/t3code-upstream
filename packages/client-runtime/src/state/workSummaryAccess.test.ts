import { AuthDiagnosticsReadScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorkSummaryAccess } from "./workSummaryAccess.ts";

describe("resolveWorkSummaryAccess", () => {
  it("needs orchestration read, not the diagnostics scope Usage uses", () => {
    const base = { connectionPhase: "connected", hasSessionError: false } as const;
    expect(
      resolveWorkSummaryAccess({
        ...base,
        session: { authenticated: true, scopes: [AuthOrchestrationReadScope] },
      }),
    ).toEqual({ canReadWork: true, isPending: false, error: null });
    expect(
      resolveWorkSummaryAccess({
        ...base,
        session: { authenticated: true, scopes: [AuthDiagnosticsReadScope] },
      }),
    ).toMatchObject({
      canReadWork: false,
      error: "This connection does not have access to threads.",
    });
  });

  it("waits for the session check while connecting, and reports an offline environment", () => {
    const connecting = resolveWorkSummaryAccess({
      connectionPhase: "connecting",
      session: null,
      hasSessionError: false,
    });
    expect(connecting).toMatchObject({ canReadWork: false, isPending: true, error: null });
    expect(
      resolveWorkSummaryAccess({
        connectionPhase: "offline",
        session: null,
        hasSessionError: false,
      }),
    ).toMatchObject({ isPending: false, error: "This environment is not connected." });
  });
});
