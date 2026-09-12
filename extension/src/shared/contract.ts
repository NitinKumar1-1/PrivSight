/**
 * Wire contract between the extension and the backend.
 *
 * Mirrors backend/app/schemas.py field for field.
 * If one side changes, the other must change with it.
 */

export type ActionType = "click" | "type" | "press" | "scroll" | "select" | "navigate" | "done";

/** What the page did after an executed action, as observed locally. */
export type ActionEffect = "url_changed" | "dom_changed" | "no_change" | "unknown";

export interface PageElement {
  /** PrivSight element identifier, stored on the element as data-ps-id. */
  id: string;
  tag: string;
  text: string;
  role: string;
  /** Nearby title and price for generic controls ("Add to cart" x 48), redacted. Absent when not needed. */
  context?: string;
  /** For a standard <select>: its selectable option labels (redacted, capped). Absent otherwise. */
  options?: string[];
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

/** One action already performed for this task (Phase 7 multi-step). Values are redacted text. */
export interface ActionRecord {
  action: ActionType;
  target: string | null;
  value: string | null;
  /** Observed page effect of the action (Phase 8). Absent for older records. */
  effect?: ActionEffect;
  /** Short local note about the action's result, value-free (for example "typed text verified; nothing submitted"). */
  note?: string;
  /**
   * Redacted label of the control the action used. LOCAL ONLY: the sanitizer
   * never copies it onto the wire; it lets the validator bound repeated
   * consequential clicks (an "Add to cart" used twice already) across steps.
   */
  label?: string;
  /** LOCAL ONLY: the executor measured cart evidence (count up, confirmation, go-to-cart) right after this click. */
  cartAdded?: boolean;
  /** LOCAL ONLY: redacted product context of the control, to tell "add to cart" of product A from product B. */
  context?: string;
  /** LOCAL ONLY: a record the controller inserted (a locally rejected "done"), not an executed step. */
  synthetic?: boolean;
}

export interface ReasonRequest {
  task: string;
  /** Sanitized page: sensitive values are already replaced by placeholders. */
  page: PageInfo;
  /** Placeholder names present in the page, e.g. ["[EMAIL_1]", "[PHONE_1]"]. Never values. */
  placeholders: string[];
  /** Sanitized structured visual observations. Absent when vision was unavailable. */
  visual?: VisualContext;
  /** Actions already executed for this task, oldest first. Absent on the first step. */
  history?: ActionRecord[];
  /**
   * The local controller's value-free note for this round (Phase 10): why a
   * "done" was rejected, what is missing, or what failed. Redacted like every
   * other field; capped at 400 characters.
   */
  guidance?: string;
}

export interface ActionResponse {
  action: ActionType;
  target?: string | null;
  value?: string | null;
  confidence: number;
  reason: string;
  /** True when this single action completes the task; false when the reasoner expects to act again (Phase 7). */
  final?: boolean;
}
