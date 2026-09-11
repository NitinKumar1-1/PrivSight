import { beforeEach, describe, expect, it } from "vitest";
import {
  EXECUTOR_SUPPORTED_ACTIONS,
  validateAction,
  type ValidationContext,
  type ValidationResult,
} from "../../src/content/action-validator";
import { findElementByPsId } from "../../src/content/element-ids";
import type { PiiType } from "../../src/privacy/types";

const SENSITIVE: Record<string, PiiType> = { el_email: "EMAIL", el_password: "PASSWORD" };
const PLACEHOLDERS: Record<string, PiiType> = { "[EMAIL_1]": "EMAIL", "[PASSWORD_1]": "PASSWORD" };

/** All six contract actions are "supported" here so contract checks can be tested on their own. */
const ALL_ACTIONS = new Set(["click", "type", "scroll", "select", "navigate", "done"] as const);

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    findElement: findElementByPsId,
    sensitiveTypeOf: (id) => SENSITIVE[id],
    placeholderType: (p) => PLACEHOLDERS[p],
    supportedActions: ALL_ACTIONS,
    ...overrides,
  };
}

function code(result: ValidationResult): string {
  return result.ok ? "ok" : result.code;
}

beforeEach(() => {
  document.body.innerHTML = `
    <button data-ps-id="el_buy_now" id="buy_now">Buy Now</button>
    <button data-ps-id="el_disabled" disabled>Nope</button>
    <input data-ps-id="el_email" type="email">
    <input data-ps-id="el_password" type="password">
    <input data-ps-id="el_search" type="text">
    <select data-ps-id="el_size"><option>M</option></select>
  `;
});

describe("valid actions", () => {
  it("valid click", () => {
    const result = validateAction({ action: "click", target: "el_buy_now", confidence: 0.95, reason: "x" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toEqual({ action: "click", target: "el_buy_now", value: null, confidence: 0.95, reason: "x" });
  });

  it("valid type into a plain field", () => {
    expect(code(validateAction({ action: "type", target: "el_search", value: "black shirt", confidence: 0.8, reason: "" }, ctx()))).toBe("ok");
  });

  it("valid type of a matching placeholder into a sensitive field", () => {
    expect(code(validateAction({ action: "type", target: "el_email", value: "[EMAIL_1]", confidence: 0.8, reason: "" }, ctx()))).toBe("ok");
  });

  it("valid scroll, select, navigate and done", () => {
    expect(code(validateAction({ action: "scroll", value: "down", confidence: 0.5, reason: "" }, ctx()))).toBe("ok");
    expect(code(validateAction({ action: "select", target: "el_size", value: "M", confidence: 0.5, reason: "" }, ctx()))).toBe("ok");
    expect(code(validateAction({ action: "navigate", value: "https://example.com/shop", confidence: 0.5, reason: "" }, ctx()))).toBe("ok");
    expect(code(validateAction({ action: "done", confidence: 1, reason: "finished" }, ctx()))).toBe("ok");
  });
});

describe("structure and allowlist", () => {
  it("missing action", () => {
    expect(code(validateAction({ target: "el_buy_now", confidence: 1 }, ctx()))).toBe("unsupported_action");
  });

  it("unknown and executable actions are blocked", () => {
    expect(code(validateAction({ action: "execute_code", target: "el_buy_now", confidence: 1 }, ctx()))).toBe("unsupported_action");
    expect(code(validateAction({ action: "run_javascript", confidence: 1 }, ctx()))).toBe("unsupported_action");
  });

  it("malformed input: not an object, array, string, null", () => {
    for (const bad of [null, undefined, "click", 42, ["click"]]) {
      expect(code(validateAction(bad, ctx()))).toBe("malformed");
    }
  });

  it("unexpected fields are blocked even on an otherwise valid action", () => {
    const result = validateAction({ action: "click", target: "el_buy_now", confidence: 1, reason: "", script: "x" }, ctx());
    expect(code(result)).toBe("unexpected_field");
  });

  it("malformed parameters: wrong field types", () => {
    expect(code(validateAction({ action: "click", target: 12, confidence: 1 }, ctx()))).toBe("malformed");
    expect(code(validateAction({ action: "click", target: "el_buy_now", confidence: 1, reason: {} }, ctx()))).toBe("malformed");
  });
});

describe("confidence is metadata, not a pass", () => {
  it("invalid confidence values are blocked", () => {
    for (const bad of [undefined, "0.9", -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(code(validateAction({ action: "click", target: "el_buy_now", confidence: bad }, ctx()))).toBe("invalid_confidence");
    }
  });

  it("confidence 1.0 does not rescue a nonexistent target", () => {
    expect(code(validateAction({ action: "click", target: "el_does_not_exist", confidence: 1.0 }, ctx()))).toBe("unknown_target");
  });
});

describe("targets", () => {
  it("missing target for click", () => {
    expect(code(validateAction({ action: "click", confidence: 0.9 }, ctx()))).toBe("missing_target");
    expect(code(validateAction({ action: "click", target: null, confidence: 0.9 }, ctx()))).toBe("missing_target");
  });

  it("nonexistent target", () => {
    const result = validateAction({ action: "click", target: "el_does_not_exist", confidence: 0.95 }, ctx());
    expect(code(result)).toBe("unknown_target");
    if (!result.ok) expect(result.reason).toBe("Target element not found on the current page");
  });

  it("target that is a selector rather than an element id", () => {
    expect(code(validateAction({ action: "click", target: "#buy_now", confidence: 1 }, ctx()))).toBe("invalid_target");
    expect(code(validateAction({ action: "click", target: "button.buy", confidence: 1 }, ctx()))).toBe("invalid_target");
  });

  it("disabled and incompatible targets", () => {
    expect(code(validateAction({ action: "click", target: "el_disabled", confidence: 1 }, ctx()))).toBe("incompatible_target");
    expect(code(validateAction({ action: "type", target: "el_buy_now", value: "x", confidence: 1 }, ctx()))).toBe("incompatible_target");
    expect(code(validateAction({ action: "select", target: "el_search", value: "x", confidence: 1 }, ctx()))).toBe("incompatible_target");
  });

  it("target removed from the page after reasoning is blocked", () => {
    document.querySelector('[data-ps-id="el_buy_now"]')?.remove();
    expect(code(validateAction({ action: "click", target: "el_buy_now", confidence: 1 }, ctx()))).toBe("unknown_target");
  });

  it("actions that take no target reject one", () => {
    expect(code(validateAction({ action: "done", target: "el_buy_now", confidence: 1 }, ctx()))).toBe("invalid_target");
  });
});

describe("values", () => {
  it("type and select require a value; scroll validates its value", () => {
    expect(code(validateAction({ action: "type", target: "el_search", confidence: 1 }, ctx()))).toBe("missing_value");
    expect(code(validateAction({ action: "select", target: "el_size", confidence: 1 }, ctx()))).toBe("missing_value");
    expect(code(validateAction({ action: "scroll", value: "sideways", confidence: 1 }, ctx()))).toBe("invalid_value");
  });
});

describe("navigation", () => {
  it("rejects javascript:, data:, vbscript: and relative or missing URLs", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox", "file:///etc/passwd", "/relative", "example.com"]) {
      const result = validateAction({ action: "navigate", value: url, confidence: 1 }, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(["dangerous_navigation", "executable_content"]).toContain(result.code);
    }
    expect(code(validateAction({ action: "navigate", confidence: 1 }, ctx()))).toBe("missing_value");
  });

  it("allows http and https", () => {
    expect(code(validateAction({ action: "navigate", value: "http://localhost:8080/", confidence: 1 }, ctx()))).toBe("ok");
  });
});

describe("executable content", () => {
  it("blocks script tags, javascript URLs and inline handlers anywhere in the action", () => {
    expect(code(validateAction({ action: "type", target: "el_search", value: "<script>alert(1)</script>", confidence: 1 }, ctx()))).toBe("executable_content");
    expect(code(validateAction({ action: "click", target: "el_buy_now", confidence: 1, reason: "javascript:void(0)" }, ctx()))).toBe("executable_content");
    expect(code(validateAction({ action: "type", target: "el_search", value: 'x" onclick="steal()', confidence: 1 }, ctx()))).toBe("executable_content");
  });
});

describe("sensitive field policy", () => {
  it("blocks a raw value into a sensitive field", () => {
    const result = validateAction({ action: "type", target: "el_password", value: "hunter2", confidence: 1 }, ctx());
    expect(code(result)).toBe("sensitive_policy");
    if (!result.ok) expect(result.reason).not.toContain("hunter2");
  });

  it("blocks a placeholder of the wrong type and an unknown placeholder", () => {
    expect(code(validateAction({ action: "type", target: "el_email", value: "[PASSWORD_1]", confidence: 1 }, ctx()))).toBe("sensitive_policy");
    expect(code(validateAction({ action: "type", target: "el_search", value: "[EMAIL_1]", confidence: 1 }, ctx()))).toBe("sensitive_policy");
    expect(code(validateAction({ action: "type", target: "el_email", value: "[EMAIL_9]", confidence: 1 }, ctx()))).toBe("sensitive_policy");
  });

  it("allows clicking a sensitive field (focus only, no value involved)", () => {
    expect(code(validateAction({ action: "click", target: "el_email", confidence: 1 }, ctx()))).toBe("ok");
  });
});

describe("executor support gate", () => {
  it("the real executor supports click and done only", () => {
    expect([...EXECUTOR_SUPPORTED_ACTIONS].sort()).toEqual(["click", "done"]);
  });

  it("a contract-valid type action is rejected as unsupported by the current executor", () => {
    const result = validateAction(
      { action: "type", target: "el_search", value: "x", confidence: 1 },
      ctx({ supportedActions: EXECUTOR_SUPPORTED_ACTIONS }),
    );
    expect(code(result)).toBe("unsupported_by_executor");
    if (!result.ok) expect(result.reason).toContain("unsupported by current executor");
  });

  it("contract failures are reported before the executor gate", () => {
    const result = validateAction(
      { action: "navigate", value: "javascript:x", confidence: 1 },
      ctx({ supportedActions: EXECUTOR_SUPPORTED_ACTIONS }),
    );
    expect(code(result)).not.toBe("unsupported_by_executor");
  });
});
