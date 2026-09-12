import { beforeEach, describe, expect, it } from "vitest";
import {
  PS_ID_ATTRIBUTE,
  ensureElementIds,
  findElementByPsId,
  findInteractiveElements,
  getAccessibleText,
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

describe("getAccessibleText on wrapper-labelled controls", () => {
  it("reads a submit input's label from a sibling aria-hidden span (Amazon-style button)", () => {
    const elements = setBody(`
      <span class="a-button a-button-primary">
        <span class="a-button-inner">
          <input class="a-button-input" type="submit">
          <span class="a-button-text" aria-hidden="true">Add to cart</span>
        </span>
      </span>
    `);
    expect(elements).toHaveLength(1);
    expect(getAccessibleText(elements[0])).toBe("Add to cart");
    expect(idsOf(elements)).toEqual(["el_add_to_cart"]);
  });

  it("resolves aria-labelledby even when the referenced node is aria-hidden", () => {
    const elements = setBody(`
      <span id="atc-announce" aria-hidden="true">Add to cart</span>
      <input type="submit" aria-labelledby="atc-announce">
    `);
    expect(getAccessibleText(elements[0])).toBe("Add to cart");
  });

  it("does not borrow a wrapper's text when the wrapper holds other controls", () => {
    const elements = setBody(`
      <div><button>Cancel</button><input type="submit"></div>
    `);
    expect(getAccessibleText(elements[1])).toBe("");
  });

  it("does not borrow long wrapper text (a card is not a label)", () => {
    const elements = setBody(`
      <div>${"Product description ".repeat(6)}<input type="submit"></div>
    `);
    expect(getAccessibleText(elements[0])).toBe("");
  });

  it("leaves text inputs alone: their wrapper text is not a label", () => {
    const elements = setBody(`<div>Search<input type="text"></div>`);
    expect(getAccessibleText(elements[0])).toBe("");
  });
});

describe("styled clickables (cursor: pointer containers)", () => {
  it("lists a short pointer-cursor div as a control and gives it a button id", () => {
    const elements = setBody(`
      <div class="pdp-actions">
        <div style="cursor:pointer"><span>ADD TO BAG</span></div>
        <p style="cursor:pointer">S</p>
        <p style="cursor:pointer">M</p>
      </div>
      <p>Regular paragraph text with no handler</p>
    `);
    expect(elements.map((el) => el.textContent?.trim())).toEqual(["ADD TO BAG", "S", "M"]);
    expect(idsOf(elements)).toEqual(["el_add_to_bag", "el_s", "el_m"]);
  });

  it("keeps the outermost pointer element, not its pointer children", () => {
    const elements = setBody(`<div style="cursor:pointer"><span style="cursor:pointer">Buy</span></div>`);
    expect(elements).toHaveLength(1);
    expect(elements[0].tagName).toBe("DIV");
  });

  it("ignores pointer containers that hold or sit inside a native control", () => {
    const elements = setBody(`
      <div style="cursor:pointer"><button>Real</button></div>
      <a href="#"><span style="cursor:pointer">Inside link</span></a>
    `);
    expect(elements.map((el) => el.tagName)).toEqual(["BUTTON", "A"]);
  });

  it("ignores pointer containers with long text (a card is not a button)", () => {
    const elements = setBody(`<div style="cursor:pointer">${"Long product card text ".repeat(4)}</div>`);
    expect(elements).toHaveLength(0);
  });

  it("interleaves styled clickables with native controls in document order", () => {
    const elements = setBody(`<button>One</button><div style="cursor:pointer">Two</div><button>Three</button>`);
    expect(elements.map((el) => el.textContent)).toEqual(["One", "Two", "Three"]);
  });
});

describe("script-driven clickables (click handler property, no pointer cursor)", () => {
  it("lists a short div with an onclick handler as a button (React Native Web pattern)", () => {
    const elements = setBody(`
      <div class="grid"><div><div onclick="void 0"><div><div dir="auto">Add to cart</div></div><span></span></div></div></div>
      <div class="grid"><div><div onclick="void 0"><div dir="auto">Buy now</div></div></div></div>
    `);
    expect(elements.map((el) => el.textContent?.trim())).toEqual(["Add to cart", "Buy now"]);
    expect(idsOf(elements)).toEqual(["el_add_to_cart", "el_buy_now"]);
    expect(elements.every((el) => el.hasAttribute("onclick"))).toBe(true);
  });

  it("still ignores handler-bearing containers with long text (a card wrapper is not a button)", () => {
    const elements = setBody(`<div onclick="void 0">${"Card text ".repeat(8)}</div>`);
    expect(elements).toHaveLength(0);
  });
});
