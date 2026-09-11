/**
 * Wire contract between the extension and the backend.
 *
 * Mirrors backend/app/schemas.py field for field.
 * If one side changes, the other must change with it.
 */

export type ActionType = "click" | "type" | "scroll" | "select" | "navigate" | "done";

export interface PageElement {
  /** PrivSight element identifier, stored on the element as data-ps-id. */
  id: string;
  tag: string;
  text: string;
  role: string;
}

export interface PageInfo {
  url: string;
  title: string;
  elements: PageElement[];
  text: string;
}

export interface VisualBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VisualObservationType = "text" | "price" | "button" | "input";

/**
 * One sanitized observation from the local vision/OCR engine. Text has been
 * through the same redactor as page text. Never image data.
 */
export interface VisualObservation {
  type: VisualObservationType;
  text: string;
  bbox: VisualBBox;
  confidence: number;
  /** data-ps-id of the live DOM element this label was mapped to, or null. */
  target: string | null;
}

export interface VisualContext {
  engine: string;
  observations: VisualObservation[];
  /** Human-readable DOM-versus-vision disagreements. DOM wins; the model is told. */
  conflicts: string[];
}

export interface ReasonRequest {
  task: string;
  /** Sanitized page: sensitive values are already replaced by placeholders. */
  page: PageInfo;
  /** Placeholder names present in the page, e.g. ["[EMAIL_1]", "[PHONE_1]"]. Never values. */
  placeholders: string[];
  /** Sanitized structured visual observations. Absent when vision was unavailable. */
  visual?: VisualContext;
}

export interface ActionResponse {
  action: ActionType;
  target?: string | null;
  value?: string | null;
  confidence: number;
  reason: string;
}
