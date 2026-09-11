import { beforeEach, describe, expect, it } from "vitest";
import { extractPageInfo } from "../src/content/perception";

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  document.title = "ShirtStore - Black Shirts";
  document.body.innerHTML = `
    <nav><a href="#products">Products</a></nav>
    <h1>Black Shirts</h1>
    <p>Black Shirt C Price: 699</p>
    <button id="buy_now">Buy Now</button>
    <input type="checkbox" id="agree">
    <div role="button" id="custom">Custom</div>
  `;
});

describe("extractPageInfo", () => {
  it("returns url, title, elements and text matching the contract shape", () => {
    const { page } = extractPageInfo();
    expect(page).toEqual({
      url: expect.any(String),
      title: "ShirtStore - Black Shirts",
      elements: expect.any(Array),
      text: expect.any(String),
    });
  });

  it("reports an empty privacy summary when the page has no PII", () => {
    const { summary } = extractPageInfo();
    expect(summary).toEqual({ placeholders: [], types: {}, detections: [] });
  });

  it("describes each element with id, tag, text and role", () => {
    const { page } = extractPageInfo();
    const button = page.elements.find((el) => el.id === "el_buy_now");
    expect(button).toEqual({ id: "el_buy_now", tag: "button", text: "Buy Now", role: "button" });
  });

  it("uses the explicit role attribute when present", () => {
    const { page } = extractPageInfo();
    const custom = page.elements.find((el) => el.id === "el_custom");
    expect(custom?.role).toBe("button");
  });

  it("infers implicit roles for links and checkboxes", () => {
    const { page } = extractPageInfo();
    expect(page.elements.find((el) => el.id === "el_products")?.role).toBe("link");
    expect(page.elements.find((el) => el.id === "el_agree")?.role).toBe("checkbox");
  });

  it("includes page text so the backend can read prices", () => {
    const { page } = extractPageInfo();
    expect(page.text).toContain("Black Shirt C");
  });

  it("stamps every reported element with a data-ps-id in the DOM", () => {
    const { page } = extractPageInfo();
    for (const el of page.elements) {
      expect(document.querySelector(`[data-ps-id="${el.id}"]`)).not.toBeNull();
    }
  });
});
