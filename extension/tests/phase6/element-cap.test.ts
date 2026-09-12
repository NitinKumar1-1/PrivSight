/**
 * Phase 6: real pages expose hundreds of controls. Discovery stays general
 * (no site-specific selectors) but is capped, prefers what is in the
 * viewport, and skips aria-hidden subtrees.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { findInteractiveElements, getAccessibleText, MAX_INTERACTIVE_ELEMENTS, prioritizeViewport } from "../../src/content/element-ids";

function rectAt(top: number) {
  return { width: 100, height: 20, top, left: 0, right: 100, bottom: top + 20, x: 0, y: top, toJSON: () => ({}) };
}

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  // jsdom has no layout: each element reports the top stored in data-top.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rectAt(Number((this as HTMLElement).dataset.top ?? "0"));
  };
});

describe("interactive element discovery on large pages", () => {
  it("keeps document order untouched when the page fits under the cap", () => {
    document.body.innerHTML = Array.from({ length: 5 }, (_, i) => `<a href="#" data-top="${i * 1000}">L${i}</a>`).join("");
    expect(findInteractiveElements().map((el) => el.textContent)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("over the cap: in-viewport elements come first in document order, then the rest, up to the cap", () => {
    const parts: string[] = [];
    for (let i = 0; i < 200; i++) parts.push(`<a href="#" data-top="${i < 100 ? 5000 : (i - 100) * 5}">L${i}</a>`);
    document.body.innerHTML = parts.join("");
    const found = findInteractiveElements(document, 120);
    expect(found).toHaveLength(120);
    expect(found.slice(0, 100).map((el) => el.textContent)).toEqual(Array.from({ length: 100 }, (_, i) => `L${i + 100}`));
    expect(found[100].textContent).toBe("L0");
  });

  it("the default cap is applied", () => {
    document.body.innerHTML = Array.from({ length: MAX_INTERACTIVE_ELEMENTS + 40 }, (_, i) => `<button data-top="10">B${i}</button>`).join("");
    expect(findInteractiveElements()).toHaveLength(MAX_INTERACTIVE_ELEMENTS);
  });

  it("skips elements inside aria-hidden subtrees", () => {
    document.body.innerHTML = `<div aria-hidden="true"><button>Ghost</button></div><button>Real</button>`;
    expect(findInteractiveElements().map((el) => el.textContent)).toEqual(["Real"]);
  });

  it("prioritizeViewport is a no-op under the limit", () => {
    document.body.innerHTML = `<button data-top="9000">Far</button><button data-top="0">Near</button>`;
    const els = Array.from(document.querySelectorAll<HTMLElement>("button"));
    expect(prioritizeViewport(els, 10)).toBe(els);
  });

  it("icon-only controls get a name from title or image alt", () => {
    document.body.innerHTML = `<button title="Search"></button><a href="#"><img alt="Home"></a><button></button>`;
    const [search, home, blank] = Array.from(document.querySelectorAll<HTMLElement>("button, a"));
    expect(getAccessibleText(search)).toBe("Search");
    expect(getAccessibleText(home)).toBe("Home");
    expect(getAccessibleText(blank)).toBe("(unlabelled icon button)"); // a fixed generic hint, never page content
  });
});
