/**
 * Phase 10: overlays and unnamed icon buttons are described generically in
 * the observation, so the reasoner can deal with a dialog in front of the
 * page (close it, or use its controls) instead of aiming at what it covers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleExtractPage } from "../../src/content/handlers";
import { iconHint, overlayAncestor, overlayContext } from "../../src/content/overlay";

/** Layout stub: data-box="x,y,w,h" per element, else a small default box. */
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    if (el.dataset?.box) {
      const [x, y, w, h] = el.dataset.box.split(",").map(Number);
      return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) };
    }
    return { width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON: () => ({}) };
  };
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
}

beforeEach(stubLayout);

const OVERLAY_PAGE = `
  <input name="q" placeholder="Search" data-box="100,20,600,40">
  <button data-box="1150,400,40,40"><svg viewBox="0 0 10 10"><path d="M1 1L9 9"/></svg></button>
  <div id="overlay" style="position:fixed;z-index:1000" data-box="0,0,1200,800">
    <div role="document">
      <h2>Log in</h2>
      <input name="loginId" placeholder="Enter Email/Mobile number" data-box="400,300,400,40">
      <button id="x" data-box="880,120,40,40"><svg viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9"/></svg></button>
      <button data-box="400,400,400,40">Request OTP</button>
    </div>
  </div>`;

describe("overlay detection", () => {
  it("finds a dialog by role, aria-modal, or a fixed full-page ancestor with a high z-index", () => {
    document.body.innerHTML = `
      <div role="dialog"><button id="a">A</button></div>
      <div aria-modal="true"><button id="b">B</button></div>
      <div style="position:fixed;z-index:500" data-box="0,0,1200,800"><button id="c">C</button></div>
      <div style="position:absolute;z-index:5" data-box="0,0,50,50"><button id="d">D</button></div>
      <button id="e">E</button>`;
    expect(overlayAncestor(document.getElementById("a")!)).not.toBeNull();
    expect(overlayAncestor(document.getElementById("b")!)).not.toBeNull();
    expect(overlayAncestor(document.getElementById("c")!)).not.toBeNull();
    expect(overlayAncestor(document.getElementById("d")!)).toBeNull(); // a small positioned box is not an overlay
    expect(overlayAncestor(document.getElementById("e")!)).toBeNull();
  });
});

describe("icon-only buttons get a generic hint", () => {
  it("uses an svg title, then class keywords, then the position inside an overlay", () => {
    document.body.innerHTML = `
      <button id="t"><svg><title>Close menu</title></svg></button>
      <button id="k" class="modal-close-btn"><svg></svg></button>
      <div style="position:fixed;z-index:1000" data-box="0,0,1200,800"><button id="tr" data-box="1100,40,40,40"><svg></svg></button><button id="in" data-box="500,400,40,40"><svg></svg></button></div>
      <button id="plain" data-box="10,700,40,40"><svg></svg></button>`;
    expect(iconHint(document.getElementById("t")!)).toBe("Close menu");
    expect(iconHint(document.getElementById("k")!)).toBe("(icon: close)");
    expect(iconHint(document.getElementById("tr")!)).toMatch(/top-right of the dialog: probably close/);
    expect(iconHint(document.getElementById("in")!)).toBe("(unlabelled icon button inside the dialog)");
    expect(iconHint(document.getElementById("plain")!)).toBe("(unlabelled icon button)");
  });
});

describe("the observation carries the overlay facts to the reasoner", () => {
  it("marks overlay controls, names the unnamed close button, and leaves the page's own controls unmarked", async () => {
    document.body.innerHTML = OVERLAY_PAGE;
    const result = await handleExtractPage("Find headphones and complete the checkout");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elements = JSON.parse(result.firewall.body).page.elements as Array<{ id: string; text: string; context?: string }>;
    const byText = (t: RegExp) => elements.find((e) => t.test(e.text));
    const close = byText(/top-right of the dialog/);
    expect(close).toBeDefined();
    expect(close?.context).toBe("inside an open dialog/overlay");
    expect(byText(/Request OTP/)?.context).toBe("inside an open dialog/overlay");
    expect(byText(/unlabelled icon button\)$/)?.context).toBeUndefined(); // the carousel arrow on the page itself
    const search = elements.find((e) => e.id === "el_q");
    expect(search?.context).toBeUndefined();
    expect(overlayContext(document.querySelector("input[name=q]")!)).toBe("");
  });

  it("the hint wording is fixed text: no page content enters it", () => {
    document.body.innerHTML = OVERLAY_PAGE;
    const hint = iconHint(document.getElementById("x")!);
    expect(hint).not.toMatch(/log in|otp|email|mobile/i);
  });
});

describe("symbol-only controls", () => {
  it("a ✕ control gets a readable hint and a valid counter id, never the malformed \"el_\"", async () => {
    document.body.innerHTML = `<div style="position:fixed;z-index:1000" data-box="0,0,1200,800"><span style="cursor:pointer" data-box="1000,180,26,32">✕</span><span style="cursor:pointer">→</span></div><button>Go</button>`;
    const result = await handleExtractPage("Find headphones");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elements = JSON.parse(result.firewall.body).page.elements as Array<{ id: string; text: string; context?: string }>;
    const close = elements.find((e) => e.text.startsWith("✕"));
    expect(close?.text).toBe("✕ (icon: close)");
    expect(close?.id).toBe("el_icon_close"); // the hint gives it a readable, valid id (no more "el_")
    expect(close?.context).toBe("inside an open dialog/overlay");
    expect(elements.find((e) => e.text.startsWith("→"))?.text).toBe("→ (icon: next)");
    expect(elements.every((e) => /^el_[a-z0-9_]+$/.test(e.id))).toBe(true);
  });
});
