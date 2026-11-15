import type { WorkShareInput } from "@t3tools/client-runtime/work-share";
import { buildWorkShareCard } from "@t3tools/client-runtime/work-share";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Dialog, DialogPopup } from "../ui/dialog";
import {
  FALLBACK_WORK_SHARE_THEME,
  readWorkShareTheme,
  renderWorkShareCardPng,
  WORK_SHARE_CARD_HEIGHT,
} from "./renderWorkShareCard";
import { WorkShareDialogBody } from "./WorkShareDialog";

const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal } }) }));

const input: WorkShareInput = {
  source: "dashboard",
  periodLabel: "Last 7 days",
  projectLabel: "acme-app",
  counts: { pullRequestsOpened: 5, pullRequestsMerged: 3 },
  insights: { mergeRatePercent: 60, tokensPerMergedPullRequest: 41_200 },
};

it("exports a real PNG painted with the app's live theme tokens", async () => {
  using _tokens = setTokens({ "--background": "oklch(0.2 0 0)", "--primary": "rgb(255, 0, 0)" });
  const theme = readWorkShareTheme();
  expect(theme.accent).toBe("#ff0000");
  expect(theme.background).not.toBe(FALLBACK_WORK_SHARE_THEME.background);

  const png = await renderWorkShareCardPng(buildWorkShareCard(input), theme);
  const bytes = new Uint8Array(await png.arrayBuffer());
  expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const bitmap = await createImageBitmap(png);
  expect(bitmap.height).toBe(WORK_SHARE_CARD_HEIGHT);
  const probe = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
  probe.drawImage(bitmap, 0, 0);
  const top = Array.from(probe.getImageData(600, 4, 1, 1).data.slice(0, 3));
  expect(top).toEqual([255, 0, 0]);
  const body = Array.from(probe.getImageData(1150, 560, 1, 1).data.slice(0, 3));
  expect(body).not.toEqual([255, 0, 0]);
  expect(body).toEqual(
    Array.from(
      (() => {
        const c = new OffscreenCanvas(1, 1).getContext("2d")!;
        c.fillStyle = theme.background;
        c.fillRect(0, 0, 1, 1);
        return c.getImageData(0, 0, 1, 1).data.slice(0, 3);
      })(),
    ),
  );
});

function setTokens(tokens: Record<string, string>): Disposable {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  return {
    [Symbol.dispose]() {
      for (const name of Object.keys(tokens)) root.style.removeProperty(name);
    },
  };
}

async function renderDialog(value: WorkShareInput) {
  return await render(
    <Dialog open>
      <DialogPopup>
        <WorkShareDialogBody input={value} />
      </DialogPopup>
    </Dialog>,
    { router: false /* no routes are used */ },
  );
}

// Browser tests load no stylesheet, so the unstyled popup sits under Base UI's fixed inert layer.
// Pointer hit-testing can't reach it; a DOM click exercises the same handler.
const domClick = (name: string, role: "button" | "checkbox" = "button") =>
  (page.getByRole(role, { name }).element() as HTMLElement).click();

it("posts privacy-safe text to the X composer only after the user clicks, with opt-ins applied", async () => {
  await using _screen = await renderDialog(input);
  await expect.element(page.getByText("Project name", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Prompts, messages and code")).toBeVisible();
  expect(openExternal).not.toHaveBeenCalled();

  domClick("Post on X…");
  const first = new URL(openExternal.mock.calls[0]![0]);
  expect(first.searchParams.get("text")).toBe(
    "Last 7 days with T3 Code: 5 PRs opened, 3 PRs merged.\n60% of opened PRs merged.",
  );

  domClick("Include the project name", "checkbox");
  await expect
    .element(page.getByRole("checkbox", { name: "Include the project name" }))
    .toBeChecked();
  domClick("Post on X…");
  expect(new URL(openExternal.mock.calls[1]![0]).searchParams.get("text")).toContain("on acme-app");

  domClick("Include tokens per merged PR", "checkbox");
  await expect
    .element(page.getByRole("checkbox", { name: "Include tokens per merged PR" }))
    .toBeChecked();
  domClick("Post on X…");
  expect(new URL(openExternal.mock.calls[2]![0]).searchParams.get("text")).toContain(
    "41.2K tokens per merged PR",
  );
});

it("can dismiss the support call-to-action and disables sharing for sample data", async () => {
  await using _screen = await renderDialog({ ...input, source: "sample" });
  await expect.element(page.getByRole("button", { name: "Post on X…" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Copy text" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Download PNG" })).toBeEnabled();
  domClick("Dismiss");
  await expect.element(page.getByText(/star it/)).not.toBeInTheDocument();
  localStorage.removeItem("t3code:work-share:support-dismissed");
});

it("explains an empty T3-tracked summary instead of offering a card of nothing", async () => {
  await using _screen = await renderDialog({
    source: "dashboard",
    periodLabel: "Last 7 days",
    projectLabel: null,
    counts: {},
  });
  await expect.element(page.getByText(/Nothing to share yet/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Post on X…" })).toBeDisabled();
});
