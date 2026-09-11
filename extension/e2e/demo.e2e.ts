/**
 * Live end-to-end price-swap test.
 *
 * For each price configuration this loads the REAL demo-site/index.html into
 * jsdom (with its own inline script), runs the real content-script handler
 * (extraction, hybrid detection, redaction, firewall), sends the approved
 * bytes through the real network gate to the live backend, hands the raw
 * response to the real validator + executor, and reads what the page's own
 * click handler wrote. Nothing about the expected answer is passed anywhere.
 *
 * Prices are swapped in memory on the file's HTML; the file on disk is never
 * modified.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { postReason } from "../src/background/api";
import { handleExecuteAction, handleExtractPage } from "../src/content/handlers";
import type { ReasonRequest } from "../src/shared/contract";

const TASK = "Find the cheapest black shirt and click Buy Now";
const DEMO_HTML = readFileSync(resolve(__dirname, "../../demo-site/index.html"), "utf-8");
const RAW_VALUES = ["demo@example.com", "9999999999", "DemoPassword123", "4111 1111 1111 1111", "123456"];
const PLACEHOLDERS = ["[EMAIL_1]", "[PHONE_1]", "[PASSWORD_1]", "[CARD_1]", "[OTP_1]"];

interface Scenario {
  name: string;
  prices: Record<"A" | "B" | "C", number>;
  expectedTarget: string;
  expectedProduct: string;
}

const SCENARIOS: Scenario[] = [
  { name: "TEST 1 original prices", prices: { A: 799, B: 899, C: 699 }, expectedTarget: "el_buy_c", expectedProduct: "Black Shirt C" },
  { name: "TEST 2 A cheapest", prices: { A: 499, B: 899, C: 699 }, expectedTarget: "el_buy_a", expectedProduct: "Black Shirt A" },
  { name: "TEST 3 B cheapest", prices: { A: 999, B: 399, C: 699 }, expectedTarget: "el_buy_b", expectedProduct: "Black Shirt B" },
  { name: "TEST 4 original prices restored", prices: { A: 799, B: 899, C: 699 }, expectedTarget: "el_buy_c", expectedProduct: "Black Shirt C" },
];

function htmlWithPrices(prices: Scenario["prices"]): string {
  let html = DEMO_HTML;
  for (const [letter, price] of Object.entries(prices)) {
    const pattern = new RegExp(`(<h2>Black Shirt ${letter}</h2>\\s*<p class="price">Price: ₹)\\d+(</p>)`);
    if (!pattern.test(html)) throw new Error(`price block for shirt ${letter} not found in demo page`);
    html = html.replace(pattern, `$1${price}$2`);
  }
  return html;
}

/** Loads the page into the jsdom document and runs its inline script, as a browser would. */
function loadPage(html: string): void {
  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error("demo page has no body");
  const body = bodyMatch[1];
  const scriptMatch = body.match(/<script>([\s\S]*?)<\/script>/);
  document.title = "ShirtStore - Black Shirts";
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, "");
  if (scriptMatch) new Function(scriptMatch[1])();
}

beforeAll(async () => {
  Element.prototype.getBoundingClientRect = () =>
    ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = () => undefined;
  try {
    const health = await fetch("http://localhost:8000/health");
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (error) {
    throw new Error(`backend is not reachable on http://localhost:8000 (${String(error)}). Start it first.`);
  }
});

describe("live price-swap reasoning through the full pipeline", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      loadPage(htmlWithPrices(scenario.prices));

      // 1. Real extraction + detection + redaction + firewall.
      const extracted = handleExtractPage(TASK);
      expect(extracted.ok).toBe(true);
      if (!extracted.ok) return;
      expect(extracted.firewall.verdict).toBe("allowed");
      if (extracted.firewall.verdict !== "allowed") return;

      const body = extracted.firewall.body;
      for (const value of RAW_VALUES) expect(body).not.toContain(value);
      for (const placeholder of PLACEHOLDERS) expect(body).toContain(placeholder);
      const parsed = JSON.parse(body) as ReasonRequest;
      const buttonIds = parsed.page.elements.filter((el) => el.id.startsWith("el_buy_")).map((el) => el.id);
      expect(buttonIds).toEqual(["el_buy_a", "el_buy_b", "el_buy_c"]);
      for (const price of Object.values(scenario.prices)) expect(parsed.page.text).toContain(String(price));

      // 2. Real network gate + live backend + cloud LLM.
      const raw = await postReason(body);
      console.log(`\n${scenario.name}\n  prices A=${scenario.prices.A} B=${scenario.prices.B} C=${scenario.prices.C}\n  cloud response: ${JSON.stringify(raw)}`);

      // 3. Real validator + executor against the live page.
      const result = handleExecuteAction(raw);
      expect(result.validation).toBe("pass");
      expect(result.ok).toBe(true);

      const status = document.getElementById("purchase-status")?.textContent ?? "";
      const clicked = document.querySelector(".buy-button.clicked")?.id ?? "(none)";
      console.log(`  page status: "${status}"\n  clicked button id: ${clicked}`);

      // 4. The page itself must show the expected product.
      expect((raw as { target?: string }).target).toBe(scenario.expectedTarget);
      expect(status).toContain(`${scenario.expectedProduct} Purchased`);
      expect(clicked).toBe(scenario.expectedTarget.replace("el_", ""));
    });
  }
});
