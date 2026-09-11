/**
 * Local neural OCR engine adapter (Tesseract.js 7, LSTM, WebAssembly).
 *
 * Pure with respect to the host: it takes an image reference and returns an
 * OcrResult. In the extension it runs inside the offscreen document with
 * worker, core and weights served from extension URLs (nothing is fetched
 * from a CDN). In Node tests it runs against local files. No chrome.* here.
 *
 * `parseTesseractResult` is exported separately so output parsing can be
 * unit tested with synthetic engine output, including malformed shapes.
 */

import { PSM, createWorker, type Worker } from "tesseract.js";
import type { OcrLine, OcrResult, OcrWord } from "./types";

export const ENGINE_LABEL = "tesseract.js 7 LSTM (wasm)";
export const DEFAULT_LANGUAGE = "eng";

export interface OcrEngineOptions {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  language?: string;
  /** Factor by which the input was upscaled before OCR; boxes are divided by it. */
  scale?: number;
  /** Tesseract page segmentation. SPARSE_TEXT keeps UI columns apart; default for screenshots. */
  pageSegmentationMode?: PSM;
  logger?: (message: string) => void;
}

/** Image forms tesseract.js accepts in both browser and Node. */
export type OcrImage = string | HTMLCanvasElement | HTMLImageElement | ImageData | Blob | Uint8Array;

export interface RecognizeOptions {
  /**
   * Same image after polarity normalisation (see preprocess.ts). When given, a
   * second pass with automatic page segmentation runs on it and lines the first
   * pass missed (no overlap with an existing line) are merged in. Recovers
   * light-on-colour labels; costs roughly one extra recognition.
   */
  secondPass?: OcrImage;
}

export interface OcrEngine {
  recognize(image: OcrImage, size: { width: number; height: number }, options?: RecognizeOptions): Promise<OcrResult>;
  terminate(): Promise<void>;
}

/** Lines from a second pass are merged only where they do not overlap a first-pass line. */
export const MERGE_IOU = 0.3;

interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The subset of tesseract.js `data` this adapter reads. */
export interface TesseractData {
  blocks?: Array<{
    paragraphs?: Array<{
      lines?: Array<{
        text?: string;
        confidence?: number;
        bbox?: TesseractBox;
        words?: Array<{ text?: string; confidence?: number; bbox?: TesseractBox }>;
      }>;
    }>;
  }> | null;
}

export async function createTesseractEngine(options: OcrEngineOptions = {}): Promise<OcrEngine> {
  const scale = options.scale ?? 1;
  const loadStart = now();
  // Only pass keys that are set: an explicit `undefined` would override
  // tesseract.js's own defaults (which differ between browser and Node).
  const workerOptions: Record<string, unknown> = { cacheMethod: "none", gzip: true };
  // Spawn the worker straight from workerPath. The default blob: URL wrapper
  // cannot importScripts an extension-hosted file under the extension CSP.
  if (options.workerPath) {
    workerOptions.workerPath = options.workerPath;
    workerOptions.workerBlobURL = false;
  }
  if (options.corePath) workerOptions.corePath = options.corePath;
  if (options.langPath) workerOptions.langPath = options.langPath;
  if (options.logger) {
    const log = options.logger;
    workerOptions.logger = (m: { status: string; progress?: number }) => log(`${m.status} ${Math.round((m.progress ?? 0) * 100)}%`);
  }
  const worker: Worker = await createWorker(options.language ?? DEFAULT_LANGUAGE, 1, workerOptions);
  const primaryMode = options.pageSegmentationMode ?? PSM.SPARSE_TEXT;
  await worker.setParameters({
    tessedit_pageseg_mode: primaryMode,
    // Tesseract writes diagnostics such as "Estimating resolution as N" to
    // stderr. In a browser worker that becomes console.error, which Chrome
    // lists on the extension's Errors page. Silence it; nothing is lost.
    debug_file: "/dev/null",
  });
  let loadMs = now() - loadStart;

  return {
    async recognize(image, size, recognizeOptions = {}) {
      const start = now();
      const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
      const firstPassMs = now() - start;
      const result = parseTesseractResult(data as TesseractData, scale, ENGINE_LABEL);
      let secondPassMs = 0;
      if (recognizeOptions.secondPass) {
        const second = now();
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        try {
          const pass2 = await worker.recognize(recognizeOptions.secondPass, {}, { blocks: true, text: true });
          const secondLines = parseTesseractResult(pass2.data as TesseractData, scale).lines.flatMap((l) => splitLineByGaps(l));
          result.lines = mergeLines(result.lines, secondLines);
        } finally {
          await worker.setParameters({ tessedit_pageseg_mode: primaryMode });
        }
        secondPassMs = now() - second;
      }
      result.imageWidth = Math.round(size.width / scale);
      result.imageHeight = Math.round(size.height / scale);
      result.timings = { loadMs, recognizeMs: firstPassMs + secondPassMs, secondPassMs: recognizeOptions.secondPass ? secondPassMs : undefined };
      result.passes = recognizeOptions.secondPass ? 2 : 1;
      loadMs = 0; // subsequent calls reuse the warm worker
      return result;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

/** Converts tesseract.js block output into OcrLines. Tolerates missing or malformed parts. */
export function parseTesseractResult(data: TesseractData | null | undefined, scale: number, engine = ENGINE_LABEL): OcrResult {
  const lines: OcrLine[] = [];
  const safeScale = scale > 0 && Number.isFinite(scale) ? scale : 1;

  for (const block of asArray(data?.blocks)) {
    for (const paragraph of asArray(block?.paragraphs)) {
      for (const line of asArray(paragraph?.lines)) {
        const words: OcrWord[] = [];
        for (const word of asArray(line?.words)) {
          const text = cleanText(word?.text);
          const bbox = toBBox(word?.bbox, safeScale);
          if (!text || !bbox) continue;
          words.push({ text, bbox, confidence: toConfidence(word?.confidence) });
        }
        const text = cleanText(line?.text) || words.map((w) => w.text).join(" ");
        const bbox = toBBox(line?.bbox, safeScale) ?? unionBox(words.map((w) => w.bbox));
        if (!text || !bbox) continue;
        lines.push({ text, bbox, confidence: toConfidence(line?.confidence), words });
      }
    }
  }

  return { engine, imageWidth: 0, imageHeight: 0, lines, timings: { loadMs: 0, recognizeMs: 0 } };
}

/** A second-pass line mostly inside a first-pass line is a fragment of it (e.g. the value of "Order ID: …") and adds nothing. */
export const MERGE_CONTAINMENT = 0.7;
/** Only confident first-pass lines may suppress second-pass lines; junk lines must not hide real text. */
export const MERGE_MIN_CONFIDENCE = 0.55;
/** A horizontal gap wider than this many line heights separates two columns that the engine fused. */
export const COLUMN_GAP_FACTOR = 1.5;

/**
 * Adds second-pass lines that neither overlap a confident first-pass line
 * (IoU <= MERGE_IOU) nor lie mostly inside one (containment <= MERGE_CONTAINMENT),
 * sorted top to bottom.
 */
export function mergeLines(primary: OcrLine[], secondary: OcrLine[]): OcrLine[] {
  const merged = [...primary];
  const confident = primary.filter((l) => l.confidence >= MERGE_MIN_CONFIDENCE);
  for (const line of secondary) {
    if (!line.text.trim()) continue;
    const covered = confident.some((existing) => iou(existing.bbox, line.bbox) > MERGE_IOU || containment(line.bbox, existing.bbox) > MERGE_CONTAINMENT);
    if (!covered) merged.push(line);
  }
  return merged.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

/**
 * Splits a line at horizontal gaps wider than COLUMN_GAP_FACTOR line heights,
 * using the word boxes: automatic segmentation fuses side-by-side columns
 * ("Phone: … Order ID: …", "Buy Now A Buy Now B") into one line, which breaks
 * label context and exact label matching. Lines without word boxes are kept as is.
 */
export function splitLineByGaps(line: OcrLine, factor = COLUMN_GAP_FACTOR): OcrLine[] {
  if (line.words.length < 2) return [line];
  const words = [...line.words].sort((a, b) => a.bbox.x - b.bbox.x);
  const threshold = factor * line.bbox.height;
  const groups: OcrWord[][] = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1];
    const gap = words[i].bbox.x - (previous.bbox.x + previous.bbox.width);
    if (gap > threshold) groups.push([words[i]]);
    else groups[groups.length - 1].push(words[i]);
  }
  if (groups.length === 1) return [line];
  return groups.map((group) => ({
    text: group.map((w) => w.text).join(" "),
    bbox: unionBox(group.map((w) => w.bbox)) ?? line.bbox,
    confidence: Math.min(...group.map((w) => w.confidence)),
    words: group,
  }));
}

/** Share of `inner`'s area that lies inside `outer`. */
function containment(inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): number {
  const w = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const h = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const area = inner.width * inner.height;
  return area > 0 ? inter / area : 0;
}

function iou(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function toConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = value > 1 ? value / 100 : value;
  return Math.round(Math.min(1, Math.max(0, normalized)) * 100) / 100;
}

function toBBox(box: TesseractBox | undefined, scale: number) {
  if (!box) return null;
  const { x0, y0, x1, y1 } = box;
  if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    x: Math.round(x0 / scale),
    y: Math.round(y0 / scale),
    width: Math.round((x1 - x0) / scale),
    height: Math.round((y1 - y0) / scale),
  };
}

export function unionBox(boxes: Array<{ x: number; y: number; width: number; height: number }>) {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
