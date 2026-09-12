/**
 * Phase 7: the action history is part of the wire contract and goes through
 * the same redaction and verification as everything else.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { verifySerializedPayload } from "../../src/privacy/leakage";
import { prepareRequest } from "../../src/content/perception";

const BASE = { task: "t", page: { url: "u", title: "t", elements: [], text: "" }, placeholders: [] };

describe("leakage verifier: history", () => {
  it("accepts a well-formed history and rejects malformed ones", () => {
    const ok = verifySerializedPayload(JSON.stringify({ ...BASE, history: [{ action: "type", target: "el_q", value: "black shirt" }, { action: "click", target: "el_go", value: null }] }), []);
    expect(ok.safe).toBe(true);
    for (const bad of [
      [{ action: "hack", target: null, value: null }],
      [{ action: "click", target: "el_x", value: null, extra: 1 }],
      [{ action: "click", target: 5, value: null }],
      "not a list",
      Array.from({ length: 21 }, () => ({ action: "scroll", target: null, value: "down" })),
    ]) {
      const result = verifySerializedPayload(JSON.stringify({ ...BASE, history: bad }), []);
      expect(result.safe, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it("a history value carrying a known raw value is caught like any other field", () => {
    const result = verifySerializedPayload(JSON.stringify({ ...BASE, history: [{ action: "type", target: "el_q", value: "demo@example.com" }] }), [{ type: "EMAIL", value: "demo@example.com" }]);
    expect(result.safe).toBe(false);
  });
});

describe("prepareRequest carries and redacts history", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="email" type="email" value="demo@example.com"><input id="q" type="search"><button id="go">Go</button>`;
    Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  });

  it("omits history on the first step and includes it, redacted, afterwards", () => {
    const first = prepareRequest("t", null, []);
    expect(first.firewall.verdict).toBe("allowed");
    if (first.firewall.verdict !== "allowed") return;
    expect(JSON.parse(first.firewall.body)).not.toHaveProperty("history");

    const next = prepareRequest("t", null, [{ action: "type", target: "el_q", value: "shirt for demo@example.com" }]);
    expect(next.firewall.verdict).toBe("allowed");
    if (next.firewall.verdict !== "allowed") return;
    const body = JSON.parse(next.firewall.body) as { history: Array<{ value: string | null }> };
    expect(body.history[0].value).toBe("shirt for [EMAIL_1]");
    expect(next.firewall.body).not.toContain("demo@example.com");
  });
});
