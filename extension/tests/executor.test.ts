import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateAction, type ValidatedAction, type ValidationContext } from "../src/content/action-validator";
import { findElementByPsId } from "../src/content/element-ids";
import { executeAction } from "../src/content/executor";

const CTX: ValidationContext = {
  findElement: findElementByPsId,
  sensitiveTypeOf: () => undefined,
  placeholderType: () => undefined,
  supportedActions: new Set(["click", "done", "type", "select"]),
  isConsequential: () => null,
  isNavigationAllowed: () => null,
};

/** The executor only accepts validated actions, so tests obtain them through the validator. */
function validated(input: unknown): ValidatedAction {
  const result = validateAction(input, CTX);
  if (!result.ok) throw new Error(`test setup: ${result.reason}`);
  return result.action;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON: () => ({}) });
  document.body.innerHTML = `<button data-ps-id="el_buy_now" id="buy_now">Buy Now</button><input data-ps-id="el_q" type="text">`;
});

const FAST = { watchMs: 30 };

describe("executeAction", () => {
  it("clicks the element whose data-ps-id matches the action target with a single normal click", async () => {
    const button = document.getElementById("buy_now") as HTMLButtonElement;
    const onClick = vi.fn();
    const onMouseDown = vi.fn();
    button.addEventListener("click", onClick);
    button.addEventListener("mousedown", onMouseDown);

    const result = await executeAction(validated({ action: "click", target: "el_buy_now", confidence: 1, reason: "" }), FAST);

    expect(result).toMatchObject({ ok: true, message: "Clicked el_buy_now", validation: "pass" });
    expect(result.postAction?.effect).toBe("no_change");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onMouseDown).not.toHaveBeenCalled(); // native control: element.click() is enough, no synthetic pointer sequence
  });

  it("falls back to a pointer sequence only for a styled control whose normal click had no effect", async () => {
    document.body.innerHTML = `<div data-ps-id="el_add_to_bag" style="cursor:pointer">ADD TO BAG</div>`;
    const div = document.querySelector("div") as HTMLDivElement;
    const seen: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) div.addEventListener(type, () => seen.push(type));

    const result = await executeAction(validated({ action: "click", target: "el_add_to_bag", confidence: 1, reason: "" }), FAST);

    expect(result.ok).toBe(true);
    expect(result.postAction?.fallbackUsed).toBe(true);
    expect(seen).toEqual(["click", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  it("clicks a wrapper-labelled submit input so the wrapper's handler runs", async () => {
    document.body.innerHTML = `
      <span id="wrap"><input data-ps-id="el_add_to_cart" type="submit"><span aria-hidden="true">Add to cart</span></span>`;
    const onClick = vi.fn((event: Event) => event.preventDefault());
    document.getElementById("wrap")?.addEventListener("click", onClick);

    const result = await executeAction(validated({ action: "click", target: "el_add_to_cart", confidence: 1, reason: "" }), FAST);

    expect(result.ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fails closed as a stale target when the element vanished between validation and execution", async () => {
    const action = validated({ action: "click", target: "el_buy_now", confidence: 1, reason: "" });
    document.getElementById("buy_now")?.remove();
    const result = await executeAction(action, FAST);
    expect(result.ok).toBe(false);
    expect(result.validation).toBe("blocked");
    expect(result.code).toBe("unknown_target");
  });

  it("reports actions the executor does not implement instead of failing silently (defence in depth past the validator)", async () => {
    const result = await executeAction({ action: "hover", target: "el_buy_now", value: null, confidence: 1, reason: "" } as unknown as ValidatedAction, FAST);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not supported by the executor");
  });

  it("treats done as a successful no-op", async () => {
    const result = await executeAction(validated({ action: "done", confidence: 1, reason: "finished" }), FAST);
    expect(result.ok).toBe(true);
  });
});
