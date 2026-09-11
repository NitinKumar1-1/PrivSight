/**
 * Local visual perception types.
 *
 * Everything here describes what the local OCR/vision engine saw. These
 * structures live inside the extension. Only the sanitized
 * VisualObservation list (see shared/contract.ts) may leave the device,
 * and only after the privacy firewall has approved the serialized request.
 */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One recognized word with its box in screenshot pixel coordinates. */
export interface OcrWord {
  text: string;
  bbox: BBox;
  /** 0..1 */
  confidence: number;
}

/** One recognized text line. */
export interface OcrLine {
  text: string;
  bbox: BBox;
  confidence: number;
  words: OcrWord[];
}

export interface OcrTimings {
  /** Worker + model load, 0 when the engine was already warm. */
  loadMs: number;
  /** Total recognition time across passes. */
  recognizeMs: number;
  /** Time of the polarity-normalised second pass, when it ran. */
  secondPassMs?: number;
}

export interface OcrResult {
  /** Human-readable engine description, e.g. "tesseract.js 7 LSTM (wasm)". */
  engine: string;
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];
  timings: OcrTimings;
  /** 1 = sparse-text pass only; 2 = plus the polarity-normalised auto-segmentation pass. */
  passes?: number;
  /** JS heap of the processing context after recognition, when the browser exposes it. */
  usedJsHeapMb?: number;
}

/** A DOM button the fusion step may map a visual label onto. */
export interface ButtonCandidate {
  id: string;
  text: string;
}
