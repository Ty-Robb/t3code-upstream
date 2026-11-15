import { useAtomValue } from "@effect/atom-react";
import {
  buildWorkShareCard,
  canIncludeTokens,
  DEFAULT_WORK_SHARE_OPTIONS,
  WORK_SHARE_REPOSITORY_URL,
  type WorkShareInput,
  type WorkShareOptions,
} from "@t3tools/client-runtime/work-share";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCopyImage,
  copyWorkCardImage,
  downloadWorkCardImage,
  openXComposer,
  shareWorkCardWithSystem,
} from "./workShareActions";
import {
  drawWorkShareCard,
  readWorkShareTheme,
  renderWorkShareCardPng,
  WORK_SHARE_CARD_HEIGHT,
  WORK_SHARE_CARD_WIDTH,
} from "./renderWorkShareCard";
import { workShareDialogInputAtom } from "./workShareDialogState";

const SUPPORT_DISMISSED_KEY = "t3code:work-share:support-dismissed";

function notifyFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Something went wrong.",
    }),
  );
}

function readSupportDismissed(): boolean {
  try {
    return localStorage.getItem(SUPPORT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function WorkShareDialogHost() {
  const input = useAtomValue(workShareDialogInputAtom);
  return (
    <Dialog
      open={input !== null}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(workShareDialogInputAtom, null);
      }}
    >
      <DialogPopup>
        {/* Keyed so each summary starts from the private defaults. */}
        {input ? <WorkShareDialogBody key={JSON.stringify(input)} input={input} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

export function WorkShareDialogBody({ input }: { readonly input: WorkShareInput }) {
  const [options, setOptions] = useState<WorkShareOptions>(DEFAULT_WORK_SHARE_OPTIONS);
  const [supportDismissed, setSupportDismissed] = useState(readSupportDismissed);
  const card = buildWorkShareCard(input, options);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read once per open: the card follows the theme the user shared from.
  const [theme] = useState(readWorkShareTheme);

  // Encoded as soon as the card changes, so share and download don't await encoding inside the
  // click; Safari drops the user gesture across that wait.
  const pngRef = useRef<Promise<Blob> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the card onto a canvas, an external imperative surface
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) drawWorkShareCard(ctx, card, theme);
    const png = renderWorkShareCardPng(card, theme);
    // Failures surface when an action awaits it.
    png.catch(() => undefined);
    pngRef.current = png;
  }, [card, theme]);
  const cardPng = () => pngRef.current ?? renderWorkShareCardPng(card, theme);
  const setSupportDismissedPersisted = (dismissed: boolean) => {
    try {
      if (dismissed) localStorage.setItem(SUPPORT_DISMISSED_KEY, "1");
      else localStorage.removeItem(SUPPORT_DISMISSED_KEY);
    } catch {
      // Dismissal is session-only when storage is unavailable.
    }
    setSupportDismissed(dismissed);
  };

  const run = (title: string, action: () => Promise<void>) => {
    void action().catch((error: unknown) => notifyFailure(title, error));
  };
  const notice = (title: string) =>
    toastManager.add(stackedThreadToast({ type: "success", title }));

  const hasProject = input.projectLabel !== null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share your work</DialogTitle>
        <DialogDescription>
          Review what leaves T3 Code. Nothing is posted until you confirm in X or your share sheet.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <canvas
          ref={canvasRef}
          width={WORK_SHARE_CARD_WIDTH}
          height={WORK_SHARE_CARD_HEIGHT}
          role="img"
          aria-label="Work card preview"
          className="mx-auto rounded-lg border"
          // The bitmap is 1200px wide; sizing it inline keeps the preview small even before CSS loads.
          style={{ width: "100%", maxWidth: "28rem", height: "auto" }}
        />
        {input.source === "dashboard" && !card.canShare ? (
          <Alert>
            <AlertDescription>
              Nothing to share for this period yet. Only activity T3 Code tracked counts.
            </AlertDescription>
          </Alert>
        ) : null}
        {input.source === "sample" ? (
          <Alert>
            <AlertDescription>
              Sample data. This is a layout preview; real counts come from your work summary, and
              sample cards can't be shared or posted.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Included</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {card.disclosed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Left out</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {card.withheld.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="grid gap-2">
          {hasProject ? (
            <Label>
              <Checkbox
                checked={options.includeProject}
                onCheckedChange={(checked) =>
                  setOptions((current) => ({ ...current, includeProject: checked === true }))
                }
              />
              Include the project name
            </Label>
          ) : null}
          {canIncludeTokens(input) ? (
            <Label>
              <Checkbox
                checked={options.includeTokens}
                onCheckedChange={(checked) =>
                  setOptions((current) => ({ ...current, includeTokens: checked === true }))
                }
              />
              Include tokens per merged PR
            </Label>
          ) : null}
        </div>
        {supportDismissed ? (
          <div>
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => setSupportDismissedPersisted(false)}
            >
              Show repository link option
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm">
            <Label>
              <Checkbox
                className="mt-0.5"
                checked={options.includeSupportLink}
                onCheckedChange={(checked) =>
                  setOptions((current) => ({ ...current, includeSupportLink: checked === true }))
                }
              />
              <span>
                Optional: add a link to the T3 Code repository ({WORK_SHARE_REPOSITORY_URL}) so
                others can star it. Off unless you tick it.
              </span>
            </Label>
            <Button
              size="compact"
              variant="ghost-muted"
              onClick={() => {
                setOptions((current) => ({ ...current, includeSupportLink: false }));
                setSupportDismissedPersisted(true);
              }}
            >
              Dismiss
            </Button>
          </div>
        )}
      </DialogPanel>
      <DialogFooter className="flex-wrap">
        <Button
          variant="outline"
          onClick={() =>
            run("Couldn't copy the post text", async () => {
              await writeTextToClipboard(card.shareText, "post text");
              notice("Post text copied");
            })
          }
          disabled={!card.canShare}
        >
          Copy text
        </Button>
        {canCopyImage() ? (
          <Button
            variant="outline"
            disabled={!card.canShare}
            onClick={() =>
              run("Couldn't copy the image", async () => {
                await copyWorkCardImage(cardPng());
                notice("Image copied");
              })
            }
          >
            Copy image
          </Button>
        ) : null}
        <Button
          variant="outline"
          // Sample cards stay downloadable as a layout check; the image is marked SAMPLE DATA.
          disabled={!card.canShare && card.source !== "sample"}
          onClick={() =>
            run("Couldn't create the image", async () => {
              downloadWorkCardImage(card, await cardPng());
            })
          }
        >
          Download PNG
        </Button>
        {typeof navigator.share === "function" ? (
          <Button
            variant="outline"
            disabled={!card.canShare}
            onClick={() =>
              run("Couldn't open the share sheet", async () => {
                await shareWorkCardWithSystem(card, await cardPng(), navigator);
              })
            }
          >
            Share…
          </Button>
        ) : null}
        <Button
          disabled={!card.canShare}
          onClick={() =>
            run("Couldn't open X", async () => {
              await openXComposer(card, (url) => ensureLocalApi().shell.openExternal(url));
            })
          }
        >
          Post on X…
        </Button>
      </DialogFooter>
    </>
  );
}
