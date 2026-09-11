/**
 * Integration tests across the content-script handlers and the network gate.
 * No chrome.* APIs are involved: handlers.ts is pure, api.ts uses fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_GATE_PREFIX, postReason } from "../../src/background/api";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";
import { Redactor } from "../../src/privacy/redactor";
import type { ApprovedPayload } from "../../src/privacy/types";

const TASK = "Find the cheapest black shirt and click Buy Now";
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "123456"];

const DEMO_PAGE = `
  <dl><dt>Email</dt><dd>demo@example.com</dd><dt>Phone</dt><dd>9999999999</dd></dl>
  <p>Black Shirt A Price: 799</p><button id="buy_a">Buy Now A</button>
  <p>Black Shirt C Price: 699</p><button id="buy_c">Buy Now C</button>
  <form>
    <label for="email">Email</label><input id="email" type="email" value="demo@example.com">
    <label for="password">Password</label><input id="password" type="password" value="DemoPassword123">
    <label>Card number <input name="card_number" autocomplete="cc-number" value="4111 1111 1111 1111"></label>
    <label>OTP <input name="otp" autocomplete="one-time-code" value="123456"></label>
  </form>
  <button id="buy_now">Buy Now</button>
`;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
  document.title = "ShirtStore - Black Shirts";
  document.body.innerHTML = DEMO_PAGE;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function clickSpy(): ReturnType<typeof vi.fn> {
  const spy = vi.fn();
  document.getElementById("buy_now")?.addEventListener("click", spy);
  return spy;
}

describe("extract -> firewall -> network gate (positive)", () => {
  it("approved bytes pass the pre-fetch gate and are sent verbatim", async () => {
    const extracted = handleExtractPage(TASK);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok || extracted.firewall.verdict !== "allowed") throw new Error("expected allowed");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: "click", target: "el_buy_now", confidence: 0.9, reason: "r" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const raw = await postReason(extracted.firewall.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(sentBody.body).toBe(extracted.firewall.body);
    for (const value of RAW_VALUES) expect(String(sentBody.body)).not.toContain(value);
    expect(raw).toEqual({ action: "click", target: "el_buy_now", confidence: 0.9, reason: "r" });
  });
});

describe("extract -> firewall (negative: unsafe payload never reaches the network)", () => {
  it("a sabotaged redactor produces a block and no fetch is possible", async () => {
    vi.spyOn(Redactor.prototype, "redactText").mockImplementation((text: string) => text);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const extracted = handleExtractPage(TASK);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.firewall.verdict).toBe("blocked");
    if (extracted.firewall.verdict === "blocked") {
      for (const value of RAW_VALUES) expect(extracted.firewall.reason).not.toContain(value);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // Nothing in the blocked result can be handed to postReason: there is no body.
    expect("body" in extracted.firewall).toBe(false);
  });

  it("the network gate itself blocks a raw value even if the firewall were bypassed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const leaked = JSON.stringify({
      task: TASK,
      page: { url: "u", title: "t", elements: [], text: "Email demo@example.com" },
      placeholders: [],
    }) as ApprovedPayload;

    await expect(postReason(leaked)).rejects.toThrow(NETWORK_GATE_PREFIX);
    await expect(postReason(leaked)).rejects.not.toThrow("demo@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the network gate fails closed on a malformed body", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(postReason("{not json" as ApprovedPayload)).rejects.toThrow(NETWORK_GATE_PREFIX);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("backend response -> validator -> executor", () => {
  it("a valid click from the backend is validated against the live page and executed", () => {
    handleExtractPage(TASK);
    const spy = clickSpy();
    const result = handleExecuteAction({ action: "click", target: "el_buy_now", confidence: 0.95, reason: "cheapest is C" });
    expect(result).toEqual({ ok: true, message: "Clicked el_buy_now", validation: "pass" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("negative: unknown target is blocked and nothing is clicked", () => {
    handleExtractPage(TASK);
    const spy = clickSpy();
    const result = handleExecuteAction({ action: "click", target: "el_random_button", confidence: 1, reason: "" });
    expect(result.validation).toBe("blocked");
    expect(result.code).toBe("unknown_target");
    expect(spy).not.toHaveBeenCalled();
  });

  it("negative: unsupported and code-like actions are blocked", () => {
    const spy = clickSpy();
    expect(handleExecuteAction({ action: "execute_code", target: "el_buy_now", confidence: 1 }).code).toBe("unsupported_action");
    expect(handleExecuteAction({ action: "click", target: "el_buy_now", confidence: 1, reason: "<script>x</script>" }).code).toBe("executable_content");
    expect(handleExecuteAction("click el_buy_now").code).toBe("malformed");
    expect(handleExecuteAction(null).code).toBe("malformed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("negative: a contract-valid type action is rejected because the executor does not support it", () => {
    handleExtractPage(TASK);
    const result = handleExecuteAction({ action: "type", target: "el_email", value: "[EMAIL_1]", confidence: 1, reason: "" });
    expect(result.validation).toBe("blocked");
    expect(result.code).toBe("unsupported_by_executor");
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("demo@example.com");
  });

  it("negative: dangerous navigation is blocked before the executor gate", () => {
    const result = handleExecuteAction({ action: "navigate", value: "javascript:alert(1)", confidence: 1, reason: "" });
    expect(result.validation).toBe("blocked");
    expect(["dangerous_navigation", "executable_content"]).toContain(result.code);
  });

  it("only the validated product button is clicked, never its siblings", () => {
    handleExtractPage(TASK);
    const spyA = vi.fn();
    const spyC = vi.fn();
    document.getElementById("buy_a")?.addEventListener("click", spyA);
    document.getElementById("buy_c")?.addEventListener("click", spyC);

    const result = handleExecuteAction({ action: "click", target: "el_buy_c", confidence: 0.9, reason: "C is cheapest" });
    expect(result).toEqual({ ok: true, message: "Clicked el_buy_c", validation: "pass" });
    expect(spyC).toHaveBeenCalledTimes(1);
    expect(spyA).not.toHaveBeenCalled();
  });

  it("done terminates safely without touching the page", () => {
    const spy = clickSpy();
    const result = handleExecuteAction({ action: "done", confidence: 1, reason: "already purchased" });
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
