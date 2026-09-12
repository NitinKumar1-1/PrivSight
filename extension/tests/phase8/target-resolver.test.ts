/**
 * Phase 8: website-agnostic target resolution against a dynamic DOM.
 * The reasoner names a ps-id; the page may have re-rendered since.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PS_ID_ATTRIBUTE, ensureElementIds, findInteractiveElements } from "../../src/content/element-ids";
import { rememberTargets, resetTargetRegistry, resolveTarget, stableName } from "../../src/content/target-resolver";

function stubLayout(): void {
  Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
}

/** Observes the page the way perception does: ids assigned, fingerprints remembered. */
function observe(contexts: Record<string, string> = {}): HTMLElement[] {
  const elements = findInteractiveElements();
  ensureElementIds(elements);
  rememberTargets(elements, new Map(Object.entries(contexts)));
  return elements;
}

beforeEach(() => {
  stubLayout();
  resetTargetRegistry();
});

describe("resolveTarget", () => {
  it("resolves by ps-id when the node is unchanged", () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    observe();
    const r = resolveTarget("el_add_to_cart");
    expect(r.ok && r.method).toBe("ps-id");
  });

  it("finds a re-rendered button again by its stable name (React replaced the node)", () => {
    document.body.innerHTML = `<div id="root"><button>Add to cart</button></div>`;
    observe();
    document.getElementById("root")!.innerHTML = `<button class="fresh">Add to cart</button>`; // same control, new node, no ps-id
    const r = resolveTarget("el_add_to_cart");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe("semantic");
      expect(r.element.className).toBe("fresh");
      expect(r.element.getAttribute(PS_ID_ATTRIBUTE)).toBe("el_add_to_cart"); // adopted, so the executor's second resolution is direct
    }
  });

  it("treats a node whose label changed as stale rather than clicking it", () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    const [button] = observe();
    button.textContent = "Remove from cart"; // the same node now does the opposite
    const r = resolveTarget("el_add_to_cart");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_target");
  });

  it("reports a stale target when the control disappeared", () => {
    document.body.innerHTML = `<button>Add to cart</button>`;
    observe();
    document.body.innerHTML = `<p>Added!</p>`;
    const r = resolveTarget("el_add_to_cart");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_target");
  });

  it("refuses to guess when several re-rendered controls match (ambiguous)", () => {
    document.body.innerHTML = `<div id="list"><button>Buy</button></div>`;
    observe();
    document.getElementById("list")!.innerHTML = `<button>Buy</button><button>Buy</button>`;
    const r = resolveTarget("el_buy");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ambiguous_target");
  });

  it("uses the recorded product context to pick the right duplicate after a re-render", () => {
    document.body.innerHTML = `
      <div id="list">
        <article><h3>Product A</h3><span>₹799</span><button>Buy</button></article>
        <article><h3>Product B</h3><span>₹699</span><button>Buy</button></article>
      </div>`;
    const elements = observe();
    const ids = elements.map((el) => el.getAttribute(PS_ID_ATTRIBUTE));
    const bId = ids[1] as string; // the second Buy
    rememberTargets(elements, new Map([[bId, "Product B | ₹699"]]));
    document.getElementById("list")!.innerHTML = `
        <article><h3>Product A</h3><span>₹799</span><button>Buy</button></article>
        <article><h3>Product B</h3><span>₹699</span><button>Buy</button></article>`;
    const r = resolveTarget(bId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.element.closest("article")?.querySelector("h3")?.textContent).toBe("Product B");
  });

  it("unknown ids without a fingerprint are simply unknown", () => {
    document.body.innerHTML = `<button>Go</button>`;
    observe();
    const r = resolveTarget("el_never_seen");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_target");
  });
});

describe("stableName", () => {
  it("names a text field by its label attributes, not its value, so typing does not make it stale", () => {
    document.body.innerHTML = `<input id="q" name="q" placeholder="Search" value="">`;
    const field = document.getElementById("q") as HTMLInputElement;
    const before = stableName(field);
    field.value = "black shirt";
    expect(stableName(field)).toBe(before);
    expect(before).toBe("q");
  });

  it("names a button by its accessible text", () => {
    document.body.innerHTML = `<button aria-label="Close dialog">×</button>`;
    expect(stableName(document.querySelector("button")!)).toBe("close dialog");
  });
});
