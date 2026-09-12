/**
 * Offscreen document: the local vision host.
 *
 * Receives a screenshot data URL from the service worker, upscales it on a
 * canvas, runs the bundled Tesseract LSTM engine (WebAssembly worker, all
 * assets served from extension URLs), and returns structured OCR lines with
 * boxes in screenshot pixel coordinates. Also renders the masked preview.
 *
 * The screenshot never leaves this document except as parsed OCR text going
 * back to the extension's own contexts. No network access happens here.
 */

import { createTesseractEngine, type OcrEngine } from "../vision/ocr";
import { polarizeRgba } from "../vision/preprocess";
import type { OcrResult } from "../vision/types";
import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";
import { PSM } from "tesseract.js";

/** Target ~2x CSS pixels; screenshots already at high DPR get less extra scaling. */
const TARGET_SCALE = 2;
/** Second OCR pass on a polarity-normalised copy (recovers light-on-colour button labels). */
const DUAL_PASS = true;

let enginePromise: Promise<OcrEngine> | null = null;
let engineScale = 1;

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse: (r: OffscreenResponse) => void) => {
  if (!message || message.target !== "offscreen") return;
  handle(message)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handle(message: OffscreenRequest): Promise<OffscreenResponse> {
  switch (message.type) {
    case "OCR_IMAGE":
      return { ok: true, result: await recognize(message.dataUrl, message.devicePixelRatio) };
    case "MASK_IMAGE":
      return { ok: true, dataUrl: await renderMask(message.dataUrl, message.regions, message.images ?? []) };
    case "VISION_INFO":
      return { ok: true, info: await visionInfo() };
  }
}

async function getEngine(scale: number): Promise<OcrEngine> {
  if (!enginePromise || engineScale !== scale) {
    engineScale = scale;
    enginePromise = createTesseractEngine({
      workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
      langPath: chrome.runtime.getURL("vendor/tessdata"),
      scale,
      pageSegmentationMode: PSM.SPARSE_TEXT,
    });
  }
  return enginePromise;
}

async function recognize(dataUrl: string, devicePixelRatio: number): Promise<OcrResult> {
  const image = await loadImage(dataUrl);
  const scale = Math.max(1, Math.min(TARGET_SCALE, TARGET_SCALE / Math.max(1, devicePixelRatio)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable in offscreen document");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const engine = await getEngine(scale);
  const secondPass = DUAL_PASS ? polarizedCopy(canvas, ctx) : undefined;
  const result = await engine.recognize(canvas, { width: canvas.width, height: canvas.height }, { secondPass });
  result.usedJsHeapMb = usedHeapMb();
  return result;
}

/** Polarity-normalised copy of the scaled capture for the second OCR pass. Local canvas only. */
function polarizedCopy(source: HTMLCanvasElement, ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  const image = ctx.getImageData(0, 0, source.width, source.height);
  polarizeRgba(image.data);
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")?.putImageData(image, 0, 0);
  return copy;
}

/**
 * Draws opaque boxes over the sensitive regions (screenshot pixel
 * coordinates) and returns a PNG data URL. The preview answers "what
 * information was removed before anything left this device", so it paints
 * exactly the redacted regions and nothing else. Pictures are NOT painted:
 * a product photo is a visual object, not sensitive information, and the
 * cloud never receives pixels anyway (it gets text observations only), so
 * covering it would misrepresent what was redacted. The `images` list is
 * kept for the popup's count and reserved for a future outline mode.
 */
type Box = { x: number; y: number; width: number; height: number };

async function renderMask(dataUrl: string, regions: Box[], _images: Box[] = []): Promise<string> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable in offscreen document");
  ctx.drawImage(image, 0, 0);
  ctx.fillStyle = "#111827";
  for (const region of regions) ctx.fillRect(region.x, region.y, region.width, region.height);
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 2;
  for (const region of regions) ctx.strokeRect(region.x, region.y, region.width, region.height);
  return canvas.toDataURL("image/png");
}

async function visionInfo() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  let webgpu = "unavailable";
  if (gpu) {
    try {
      webgpu = (await gpu.requestAdapter()) ? "adapter available (not used by the OCR engine)" : "no adapter";
    } catch {
      webgpu = "error querying adapter";
    }
  }
  return { engine: "tesseract.js 7 LSTM (wasm)", backend: "WebAssembly (SIMD)", webgpu };
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("screenshot could not be decoded"));
    image.src = dataUrl;
  });
}

function usedHeapMb(): number | undefined {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : undefined;
}
