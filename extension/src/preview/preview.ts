/**
 * Full-size view of the locally masked screen capture. Reads the last run's
 * PREVIEW message from session storage (the same image the popup shows) and
 * renders it in a tab, where it can be seen at actual size. Nothing here
 * touches the network; the image never leaves the browser.
 */

import { RUN_LOG_KEY, type RunLog } from "../shared/messages";

const image = document.getElementById("image") as HTMLImageElement;
const empty = document.getElementById("empty") as HTMLDivElement;
const meta = document.getElementById("meta") as HTMLSpanElement;
const fit = document.getElementById("fit") as HTMLButtonElement;

async function load(): Promise<void> {
  let log: RunLog | undefined;
  try {
    const items = await chrome.storage?.session?.get(RUN_LOG_KEY);
    log = items?.[RUN_LOG_KEY] as RunLog | undefined;
  } catch {
    log = undefined;
  }
  const preview = log?.messages?.find((m) => m.type === "PREVIEW" && m.maskedDataUrl);
  if (!preview || preview.type !== "PREVIEW" || !preview.maskedDataUrl) return;
  image.src = preview.maskedDataUrl;
  image.hidden = false;
  empty.hidden = true;
  const pictures = preview.imageCount ? ` · ${preview.imageCount} picture(s) on screen stay on this device` : "";
  meta.textContent = `${preview.maskCount} sensitive region(s) masked locally${pictures}${log?.task ? ` · task: ${log.task.slice(0, 80)}` : ""}`;
}

function toggle(): void {
  const actual = document.body.classList.toggle("actual");
  fit.textContent = actual ? "Fit to window" : "Actual size";
}

fit.addEventListener("click", toggle);
image.addEventListener("click", toggle);
void load();
