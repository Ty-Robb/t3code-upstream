import { buildWorkShareCard } from "@t3tools/client-runtime/work-share";
import { describe, expect, it, vi } from "vite-plus/test";

import { openXComposer, shareWorkCardWithSystem } from "./workShareActions";

const card = buildWorkShareCard({
  source: "dashboard",
  periodLabel: "Last 7 days",
  projectLabel: null,
  counts: { pullRequestsOpened: 2 },
});
const sample = buildWorkShareCard({
  source: "sample",
  periodLabel: "Last 7 days",
  projectLabel: null,
  counts: { pullRequestsOpened: 2 },
});
const png = new Blob(["png"], { type: "image/png" });

describe("shareWorkCardWithSystem", () => {
  it("shares the PNG and text when the platform accepts files", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const outcome = await shareWorkCardWithSystem(card, png, { share, canShare: () => true });
    expect(outcome).toBe("shared");
    const data = share.mock.calls[0]![0] as ShareData;
    expect(data.files?.[0]?.name).toBe("t3-code-work-last-7-days.png");
    expect(data.files?.[0]?.type).toBe("image/png");
    expect(data.text).toBe(card.shareText);
  });

  it("falls back to text alone when files can't be shared", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    await shareWorkCardWithSystem(card, png, { share, canShare: () => false });
    expect(share).toHaveBeenCalledWith({ text: card.shareText });
  });

  it("reports unsupported without a share API, and cancelled when dismissed", async () => {
    expect(await shareWorkCardWithSystem(card, png, {})).toBe("unsupported");
    const abort = async () => {
      throw new DOMException("dismissed", "AbortError");
    };
    expect(await shareWorkCardWithSystem(card, png, { share: abort })).toBe("cancelled");
  });

  it("never shares sample data", async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    expect(await shareWorkCardWithSystem(sample, png, { share })).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });
});

describe("openXComposer", () => {
  it("opens the compose intent with the post text, and nothing for sample data", async () => {
    const open = vi.fn(async (_url: string) => {});
    expect(await openXComposer(card, open)).toBe(true);
    const url = new URL(open.mock.calls[0]![0]);
    expect(url.hostname).toBe("x.com");
    expect(url.searchParams.get("text")).toBe(card.shareText);
    expect(await openXComposer(sample, open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
