/**
 * Types for local PII detection, redaction and the privacy firewall.
 *
 * Everything in this module stays inside the content script. Raw values
 * never leave the page; only placeholder names, types and signal names are
 * reported.
 */

export type PiiType = "EMAIL" | "PHONE" | "CARD" | "CVV" | "OTP" | "PASSWORD";

/** Tie-break order: the more specific type wins when scores are equal. */
export const PII_TYPES: readonly PiiType[] = ["PASSWORD", "OTP", "CVV", "CARD", "EMAIL", "PHONE"];

/** One sensitive field found on the page. Contains no value. */
export interface Detection {
  type: PiiType;
  elementId: string;
  placeholder: string;
  /** Safe evidence names, e.g. "type=password", "autocomplete=cc-number". */
  signals: string[];
}

/** Safe-to-share description of what was redacted. Contains no values. */
export interface PrivacySummary {
  /** Placeholder names in the order they were assigned, e.g. ["[EMAIL_1]", "[PHONE_1]"]. */
  placeholders: string[];
  /** Placeholder name -> PII type, e.g. { "[EMAIL_1]": "EMAIL" }. */
  types: Record<string, PiiType>;
  /** Field-level detections with their evidence. */
  detections: Detection[];
}

/** A raw value the redactor knows about. Never leaves the content script. */
export interface KnownValue {
  type: PiiType;
  value: string;
}

/**
 * Serialized request body that passed the privacy firewall.
 *
 * The brand is a compile-time convenience only. The runtime guarantee comes
 * from the leakage verifier that produced this string and from the pattern
 * re-check that runs again immediately before fetch.
 */
export type ApprovedPayload = string & { readonly __privsightApproved: unique symbol };

export interface LeakageCheck {
  name: "structure" | "known-values" | "patterns";
  passed: boolean;
}

export type LeakageResult =
  | { safe: true; checks: LeakageCheck[] }
  | { safe: false; type: PiiType | "UNKNOWN"; reason: string; checks: LeakageCheck[] };

export type FirewallVerdict =
  | { verdict: "allowed"; body: ApprovedPayload; checks: LeakageCheck[] }
  | { verdict: "blocked"; reason: string; checks: LeakageCheck[] };
