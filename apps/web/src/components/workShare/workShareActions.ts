import { buildXComposeUrl, type WorkShareCard } from "@t3tools/client-runtime/work-share";

export type WorkShareOutcome = "shared" | "cancelled" | "unsupported";

export interface WorkShareNavigator {
  readonly share?: (data: ShareData) => Promise<void>;
  readonly canShare?: (data: ShareData) => boolean;
}

/**
 * Opens the OS/browser share sheet. Prefers the PNG plus text; falls back to text alone when the
 * platform can't share files, and reports `unsupported` so the caller can offer download/copy.
 */
export async function shareWorkCardWithSystem(
  card: WorkShareCard,
  png: Blob,
  nav: WorkShareNavigator,
): Promise<WorkShareOutcome> {
  if (!card.canShare || !nav.share) return "unsupported";
  const file = new File([png], card.fileName, { type: "image/png" });
  const withFile: ShareData = { files: [file], text: card.shareText };
  const data = nav.canShare?.(withFile) ? withFile : { text: card.shareText };
  try {
    await nav.share(data);
    return "shared";
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return "cancelled";
    throw cause;
  }
}

/** Opens X's compose window pre-filled. Nothing is posted until the user confirms there. */
export async function openXComposer(
  card: WorkShareCard,
  openExternal: (url: string) => Promise<void>,
): Promise<boolean> {
  if (!card.canShare) return false;
  await openExternal(buildXComposeUrl(card.shareText));
  return true;
}

export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/** Takes the PNG as a promise so the clipboard write starts inside the click, as Safari requires. */
export async function copyWorkCardImage(png: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function downloadWorkCardImage(card: WorkShareCard, png: Blob): void {
  const url = URL.createObjectURL(png);
  const link = document.createElement("a");
  link.href = url;
  link.download = card.fileName;
  link.click();
  // The click starts the download synchronously; revoke after the task so Safari keeps the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
