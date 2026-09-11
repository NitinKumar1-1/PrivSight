/**
 * Replaces sensitive values with typed placeholders such as [EMAIL_1].
 *
 * One Redactor lives for one extraction run. It owns the only copy of the
 * placeholder -> raw value map. That map is never serialized, logged or
 * sent over chrome.runtime messaging. `knownValues()` exists solely so the
 * privacy firewall, in the same content script, can verify the outgoing
 * bytes against it.
 */

import { findTextMatches } from "./detectors";
import type { KnownValue, PiiType, PrivacySummary, Detection } from "./types";

/** Redaction output; a detector must never re-register it as a value. */
const PLACEHOLDER_SHAPE = /^\[[A-Z]+_\d+\]$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly counters = new Map<PiiType, number>();
  private readonly placeholderByValue = new Map<string, string>();
  private readonly valueByPlaceholder = new Map<string, string>();
  private readonly typeByPlaceholder = new Map<string, PiiType>();
  private readonly detections: Detection[] = [];

  /** Returns the placeholder for a value, allocating one on first sight. */
  placeholderFor(type: PiiType, value: string): string {
    const existing = this.placeholderByValue.get(value);
    if (existing) return existing;

    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);

    const placeholder = `[${type}_${next}]`;
    this.placeholderByValue.set(value, placeholder);
    this.valueByPlaceholder.set(placeholder, value);
    this.typeByPlaceholder.set(placeholder, type);
    return placeholder;
  }

  /** Records field-level evidence for the summary. Contains no value. */
  recordDetection(detection: Detection): void {
    this.detections.push(detection);
  }

  /**
   * Redacts free text. Values already known from form fields are replaced
   * first (longest first), then pattern-based detection runs on the rest.
   */
  redactText(text: string): string {
    if (!text) return text;
    let result = this.replaceKnownValues(text);

    const matches = findTextMatches(result).filter((m) => !PLACEHOLDER_SHAPE.test(m.value));
    for (let i = matches.length - 1; i >= 0; i--) {
      const { type, value, index } = matches[i];
      const placeholder = this.placeholderFor(type, value);
      result = result.slice(0, index) + placeholder + result.slice(index + value.length);
    }
    return result;
  }

  /** Local-only lookup for a later "type [EMAIL_1]" executor. */
  resolve(placeholder: string): string | undefined {
    return this.valueByPlaceholder.get(placeholder);
  }

  /** PII type of a placeholder this run assigned, if any. */
  typeOf(placeholder: string): PiiType | undefined {
    return this.typeByPlaceholder.get(placeholder);
  }

  /** Raw values for the firewall. Never leaves the content script. */
  knownValues(): KnownValue[] {
    return Array.from(this.valueByPlaceholder.entries()).map(([placeholder, value]) => ({
      type: this.typeByPlaceholder.get(placeholder) as PiiType,
      value,
    }));
  }

  summary(): PrivacySummary {
    const placeholders = Array.from(this.valueByPlaceholder.keys());
    const types: Record<string, PiiType> = {};
    for (const placeholder of placeholders) {
      types[placeholder] = this.typeByPlaceholder.get(placeholder) as PiiType;
    }
    return { placeholders, types, detections: [...this.detections] };
  }

  private replaceKnownValues(text: string): string {
    const values = Array.from(this.placeholderByValue.keys()).sort((a, b) => b.length - a.length);
    let result = text;
    for (const value of values) {
      if (!result.includes(value)) continue;
      const placeholder = this.placeholderByValue.get(value) as string;
      // A purely numeric value (OTP, phone) embedded inside a longer digit run
      // is a different number (an order id that happens to contain the OTP's
      // digits), so it is replaced only on digit boundaries.
      result = /^[\d\s-]+$/.test(value)
        ? result.replace(new RegExp(`(?<!\\d)${escapeRegExp(value)}(?!\\d)`, "g"), placeholder)
        : result.split(value).join(placeholder);
    }
    return result;
  }
}
