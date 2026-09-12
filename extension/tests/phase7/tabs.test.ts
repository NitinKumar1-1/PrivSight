import { describe, expect, it } from "vitest";
import { adoptOpenedTab, isWebAddress, tabAddress } from "../../src/agent/tabs";

describe("adoptOpenedTab", () => {
  it("switches to a tab opened by the agent's tab", () => {
    expect(adoptOpenedTab(7, { id: 9, openerTabId: 7 })).toBe(9);
  });

  it("ignores tabs opened elsewhere or without an id", () => {
    expect(adoptOpenedTab(7, { id: 9, openerTabId: 3 })).toBe(7);
    expect(adoptOpenedTab(7, { id: 9 })).toBe(7);
    expect(adoptOpenedTab(7, { openerTabId: 7 })).toBe(7);
  });
});

describe("tabAddress", () => {
  it("uses the pending URL while a freshly opened tab is still loading (its url is an empty string)", () => {
    expect(tabAddress({ url: "", pendingUrl: "https://shop.example/p/1" })).toBe("https://shop.example/p/1");
  });

  it("prefers the committed URL once there is one", () => {
    expect(tabAddress({ url: "https://shop.example/p/1", pendingUrl: "https://shop.example/p/2" })).toBe("https://shop.example/p/1");
  });

  it("is empty for a missing tab", () => {
    expect(tabAddress(null)).toBe("");
    expect(tabAddress({})).toBe("");
  });
});

describe("isWebAddress", () => {
  it("accepts http(s) pages and nothing else", () => {
    expect(isWebAddress("https://shop.example/")).toBe(true);
    expect(isWebAddress("http://localhost:3000/")).toBe(true);
    expect(isWebAddress("about:blank")).toBe(false);
    expect(isWebAddress("chrome://newtab/")).toBe(false);
    expect(isWebAddress("")).toBe(false);
  });
});
