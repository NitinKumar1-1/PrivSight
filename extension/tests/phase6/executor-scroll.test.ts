/**
 * Phase 6: bounded scroll in the executor. Scroll must still come through the
 * validator; the executor never receives an unvalidated object.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXECUTOR_SUPPORTED_ACTIONS, validateAction, type ValidatedAction, type ValidationContext } from "../../src/content/action-validator";
import { findElementByPsId } from "../../src/content/element-ids";
import { executeAction, SCROLL_STEP_FRACTION } from "../../src/content/executor";

const CTX: ValidationContext = {
  findElement: findElementByPsId,
  sensitiveTypeOf: () => undefined,
  placeholderType: () => undefined,
  supportedActions: EXECUTOR_SUPPORTED_ACTIONS,
  isConsequential: () => null,
  isNavigationAllowed: () => "Navigation blocked in this test",
};

function validated(input: unknown): ValidatedAction {
  const result = validateAction(input, CTX);
  if (!result.ok) throw new Error(`test setup: ${result.reason}`);
  return result.action;
}

let scrollBy: ReturnType<typeof vi.fn>;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = `<button data-ps-id="el_go">Go</button>`;
  scrollBy = vi.fn();
  scrollTo = vi.fn();
  Object.defineProperty(window, "scrollBy", { value: scrollBy, configurable: true });
  Object.defineProperty(window, "scrollTo", { value: scrollTo, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
});

describe("executor scroll", () => {
  it("scroll down moves by a bounded fraction of the viewport", async () => {
    const result = await executeAction(validated({ action: "scroll", value: "down", confidence: 0.9, reason: "" }), { watchMs: 20 });
    expect(result).toMatchObject({ ok: true, message: "Scrolled down", validation: "pass" });
    expect(scrollBy).toHaveBeenCalledWith({ top: Math.round(1000 * SCROLL_STEP_FRACTION), left: 0 });
  });

  it("scroll up moves the other way; a missing value defaults to down", async () => {
    await executeAction(validated({ action: "scroll", value: "up", confidence: 0.9, reason: "" }), { watchMs: 20 });
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -Math.round(1000 * SCROLL_STEP_FRACTION), left: 0 });
    const result = await executeAction(validated({ action: "scroll", confidence: 0.9, reason: "" }), { watchMs: 20 });
    expect(result.message).toBe("Scrolled down");
  });

  it("top and bottom jump to the page ends", async () => {
    await executeAction(validated({ action: "scroll", value: "top", confidence: 1, reason: "" }), { watchMs: 20 });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0 });
    await executeAction(validated({ action: "scroll", value: "bottom", confidence: 1, reason: "" }), { watchMs: 20 });
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 0 }));
  });

  it("the validator still rejects a scroll with a target, a bad direction, or executable content", () => {
    expect(validateAction({ action: "scroll", target: "el_go", value: "down", confidence: 1 }, CTX).ok).toBe(false);
    expect(validateAction({ action: "scroll", value: "sideways", confidence: 1 }, CTX).ok).toBe(false);
    expect(validateAction({ action: "scroll", value: "down", confidence: 1, reason: "<script>x</script>" }, CTX).ok).toBe(false);
  });

  it("select and navigate are still refused by the executor gate, and type needs a text field", () => {
    for (const input of [
      { action: "type", target: "el_go", value: "x", confidence: 1 },
      { action: "select", target: "el_go", value: "x", confidence: 1 },
      { action: "navigate", value: "https://example.com/", confidence: 1 },
    ]) {
      const result = validateAction(input, CTX);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(["unsupported_by_executor", "incompatible_target", "navigation_not_authorised"]).toContain(result.code);
    }
  });
});
