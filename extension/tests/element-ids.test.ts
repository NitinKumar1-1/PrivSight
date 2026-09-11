import { beforeEach, describe, expect, it } from "vitest";
import {
  PS_ID_ATTRIBUTE,
  ensureElementIds,
  findElementByPsId,
  findInteractiveElements,
} from "../src/content/element-ids";

// jsdom does not run layout, so give every element a non-zero box.
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
}

function setBody(html: string): HTMLElement[] {
  document.body.innerHTML = html;
  const elements = findInteractiveElements();
  ensureElementIds(elements);
  return elements;
}

function idsOf(elements: HTMLElement[]): string[] {
  return elements.map((el) => el.getAttribute(PS_ID_ATTRIBUTE) ?? "");
}

beforeEach(stubLayout);

describe("findInteractiveElements", () => {
  it("collects buttons, links, inputs, selects and textareas", () => {
    const elements = setBody(`
      <button>Go</button>
      <a href="#x">Link</a>
      <input type="text">
      <select><option>1</option></select>
      <textarea></textarea>
      <p>plain text</p>
    `);
    expect(elements.map((el) => el.tagName.toLowerCase())).toEqual([
      "button", "a", "input", "select", "textarea",
    ]);
  });

  it("skips hidden inputs and elements with display none", () => {
    const elements = setBody(`
      <input type="hidden">
      <button style="display:none">Hidden</button>
      <button>Visible</button>
    `);
    expect(elements).toHaveLength(1);
    expect(elements[0].textContent).toBe("Visible");
  });
});

describe("ensureElementIds", () => {
  it("derives the id from the element's own id attribute", () => {
    const elements = setBody(`<button id="buy_now">Buy Now</button>`);
    expect(idsOf(elements)).toEqual(["el_buy_now"]);
  });

  it("falls back to a slug of the visible text", () => {
    const elements = setBody(`<button>Add To Cart!</button>`);
    expect(idsOf(elements)).toEqual(["el_add_to_cart"]);
  });

  it("falls back to a counter when there is no id and no text", () => {
    const elements = setBody(`<input type="text"><input type="text">`);
    expect(idsOf(elements)).toEqual(["el_1", "el_2"]);
  });

  it("never assigns the same id twice on one page", () => {
    const elements = setBody(`<button>Buy</button><button>Buy</button>`);
    const ids = idsOf(elements);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("el_buy");
  });

  it("is idempotent: a second pass leaves existing ids untouched", () => {
    const elements = setBody(`<button id="buy_now">Buy Now</button><a href="#">Home</a>`);
    const first = idsOf(elements);
    ensureElementIds(findInteractiveElements());
    expect(idsOf(findInteractiveElements())).toEqual(first);
  });

  it("is generic: does not depend on any specific button text", () => {
    const elements = setBody(`<button id="checkout">Proceed</button>`);
    expect(idsOf(elements)).toEqual(["el_checkout"]);
  });
});

describe("findElementByPsId", () => {
  it("resolves an element by its data-ps-id", () => {
    setBody(`<button id="buy_now">Buy Now</button>`);
    const found = findElementByPsId("el_buy_now");
    expect(found?.textContent).toBe("Buy Now");
  });

  it("returns null for an unknown id", () => {
    setBody(`<button id="buy_now">Buy Now</button>`);
    expect(findElementByPsId("el_missing")).toBeNull();
  });
});
