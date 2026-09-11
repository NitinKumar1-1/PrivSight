import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAction, type ValidatedAction, type ValidationContext } from "../src/content/action-validator";
import { findElementByPsId } from "../src/content/element-ids";
import { executeAction } from "../src/content/executor";

const CTX: ValidationContext = {
  findElement: findElementByPsId,
  sensitiveTypeOf: () => undefined,
  placeholderType: () => undefined,
  supportedActions: new Set(["click", "done", "type"]),
};

/** The executor only accepts validated actions, so tests obtain them through the validator. */
function validated(input: unknown): ValidatedAction {
  const result = validateAction(input, CTX);
  if (!result.ok) throw new Error(`test setup: ${result.reason}`);
  return result.action;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `<button data-ps-id="el_buy_now" id="buy_now">Buy Now</button><input data-ps-id="el_q" type="text">`;
});

describe("executeAction", () => {
  it("clicks the element whose data-ps-id matches the action target", () => {
    const button = document.getElementById("buy_now") as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    const result = executeAction(validated({ action: "click", target: "el_buy_now", confidence: 1, reason: "" }));

    expect(result).toEqual({ ok: true, message: "Clicked el_buy_now", validation: "pass" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when the target vanished between validation and execution", () => {
    const action = validated({ action: "click", target: "el_buy_now", confidence: 1, reason: "" });
    document.getElementById("buy_now")?.remove();
    const result = executeAction(action);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("el_buy_now");
  });

  it("reports actions the executor does not implement instead of failing silently", () => {
    const result = executeAction(validated({ action: "type", target: "el_q", value: "hi", confidence: 1, reason: "" }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not supported by the executor");
  });

  it("treats done as a successful no-op", () => {
    const result = executeAction(validated({ action: "done", confidence: 1, reason: "finished" }));
    expect(result.ok).toBe(true);
  });
});
