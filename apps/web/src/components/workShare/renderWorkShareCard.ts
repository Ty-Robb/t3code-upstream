import type { WorkShareCard } from "@t3tools/client-runtime/work-share";

import { APP_BASE_NAME } from "~/branding";

// 1.91:1 is what X and most feeds crop a large link/image preview to.
export const WORK_SHARE_CARD_WIDTH = 1200;
export const WORK_SHARE_CARD_HEIGHT = 630;

/** The app's own look, so the card matches the dashboard in the user's current theme. */
export interface WorkShareTheme {
  readonly brandName: string;
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
}

// Light-theme tokens from index.css, used when a token can't be resolved (tests, SSR).
export const FALLBACK_WORK_SHARE_THEME: WorkShareTheme = {
  brandName: "T3 Code",
  background: "#fcfcfd",
  surface: "#ffffff",
  border: "#e4e4e7",
  foreground: "#18181b",
  muted: "#71717a",
  accent: "#2f3fd9",
};

const TOKENS: ReadonlyArray<readonly [Exclude<keyof WorkShareTheme, "brandName">, string]> = [
  ["background", "--background"],
  ["surface", "--card"],
  ["border", "--border"],
  ["foreground", "--foreground"],
  ["muted", "--muted-foreground"],
  ["accent", "--primary"],
];

/**
 * Resolves the live CSS tokens the dashboard is styled with. Colours go through a canvas so
 * modern syntaxes (oklch, color-mix) come back in a form every canvas accepts.
 */
export function readWorkShareTheme(): WorkShareTheme {
  const scratch = document.createElement("canvas").getContext("2d");
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  try {
    const resolved = { ...FALLBACK_WORK_SHARE_THEME, brandName: APP_BASE_NAME };
    for (const [key, token] of TOKENS) {
      probe.style.color = `var(${token})`;
      const value = getComputedStyle(probe).color;
      if (!scratch || !value) continue;
      scratch.fillStyle = "#000001";
      scratch.fillStyle = value;
      // An unparseable value leaves the sentinel in place, so the fallback stands.
      if (scratch.fillStyle !== "#000001") resolved[key] = scratch.fillStyle;
    }
    return resolved;
  } finally {
    probe.remove();
  }
}

const FONT = '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

// The T3 mark from assets/prod/logo.svg, on a 128-unit grid.
const LOGO_TILE = new Path2D(
  "M0 10C0 4.47715 4.47715 0 10 0H118C123.523 0 128 4.47715 128 10V118C128 123.523 123.523 128 118 128H10C4.47715 128 0 123.523 0 118V10Z",
);
const LOGO_GLYPH = new Path2D(
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z",
);

/** Draws the card once, statically. Preview and export use the same pixels. */
export function drawWorkShareCard(
  ctx: CanvasRenderingContext2D,
  card: WorkShareCard,
  theme: WorkShareTheme,
): void {
  const w = WORK_SHARE_CARD_WIDTH;
  const h = WORK_SHARE_CARD_HEIGHT;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, w, 10);

  ctx.save();
  ctx.translate(72, 64);
  ctx.scale(0.5, 0.5);
  // The mark is black on white in light mode; inverting it keeps it visible on a dark card.
  ctx.fillStyle = theme.foreground;
  ctx.fill(LOGO_TILE);
  ctx.fillStyle = theme.background;
  ctx.fill(LOGO_GLYPH);
  ctx.restore();

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = theme.foreground;
  ctx.font = `700 36px ${FONT}`;
  ctx.fillText(theme.brandName, 152, 110);

  ctx.fillStyle = theme.muted;
  ctx.font = `500 30px ${FONT}`;
  const scope = card.projectLabel ? `${card.periodLabel} · ${card.projectLabel}` : card.periodLabel;
  ctx.fillText(scope, 72, 190);

  const count = Math.max(card.stats.length, 1);
  const gap = 32;
  const tileWidth = (w - 144 - gap * (count - 1)) / count;
  card.stats.forEach((stat, index) => {
    const x = 72 + index * (tileWidth + gap);
    ctx.beginPath();
    ctx.roundRect(x, 240, tileWidth, 220, 16);
    ctx.fillStyle = theme.surface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = theme.foreground;
    ctx.font = `700 ${tileWidth > 300 ? 112 : 88}px ${FONT}`;
    ctx.fillText(String(stat.value), x + 36, 366, tileWidth - 72);
    ctx.fillStyle = theme.muted;
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(stat.label, x + 36, 422, tileWidth - 72);
  });

  if (card.insights.length > 0) {
    ctx.fillStyle = theme.foreground;
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(card.insights.join("   ·   "), 72, 514, w - 144);
  }

  if (card.coverageNote) {
    ctx.fillStyle = theme.muted;
    ctx.font = `500 26px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(card.coverageNote, w - 72, h - 56);
    ctx.textAlign = "left";
  }

  ctx.fillStyle = card.source === "sample" ? theme.accent : theme.muted;
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText(
    card.source === "sample" ? "SAMPLE DATA: not real activity" : `Made with ${theme.brandName}`,
    72,
    h - 56,
  );
}

/** Rasterises the card to a PNG. */
export async function renderWorkShareCardPng(
  card: WorkShareCard,
  theme: WorkShareTheme = readWorkShareTheme(),
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = WORK_SHARE_CARD_WIDTH;
  canvas.height = WORK_SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable, so the card image can't be created.");
  drawWorkShareCard(ctx, card, theme);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the card as PNG."))),
      "image/png",
    ),
  );
}
