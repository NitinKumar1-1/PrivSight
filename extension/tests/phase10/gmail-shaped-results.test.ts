/**
 * Phase 10: a mail-client-shaped results page (rows with a row role and a
 * pointer cursor, no links or buttons) yields clickable result controls, so
 * "search, then open the matching message" can continue past the search.
 * Generic markup; no product or site names in the code under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleExecuteAction, handleExtractPage } from "../../src/content/handlers";

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => ({ width: 600, height: 24, top: 10, left: 10, right: 610, bottom: 34, x: 10, y: 10, toJSON: () => ({}) });
  Element.prototype.scrollIntoView = vi.fn();
});

const RESULTS = `
  <form><input name="q" placeholder="Search mail"><button>Search</button></form>
  <table role="grid"><tbody>
    <tr role="row" style="cursor:pointer"><td role="gridcell"><input type="checkbox"></td><td role="gridcell">John Carter</td><td role="gridcell">Quarterly numbers - the deck is attached, let me know</td><td role="gridcell">10:42</td></tr>
    <tr role="row" style="cursor:pointer"><td role="gridcell"><input type="checkbox"></td><td role="gridcell">John Carter</td><td role="gridcell">Re: lunch on Friday</td><td role="gridcell">Sep 9</td></tr>
    <tr role="row" style="cursor:pointer"><td role="gridcell"><input type="checkbox"></td><td role="gridcell">Newsletter</td><td role="gridcell">This week in tech</td><td role="gridcell">Sep 8</td></tr>
  </tbody></table>`;

describe("D. result rows are discovered as controls after a search", () => {
  it("each row is one control carrying sender, subject and date; the row's checkbox does not hide it", async () => {
    document.body.innerHTML = RESULTS;
    const result = await handleExtractPage("open the most recent email from John");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const elements = JSON.parse(result.firewall.body).page.elements as Array<{ id: string; tag: string; role: string; text: string }>;
    const rows = elements.filter((e) => e.tag === "tr");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ role: "row" });
    expect(rows[0].text).toMatch(/John Carter.*Quarterly numbers.*10:42/);
    expect(rows[1].text).toMatch(/Sep 9/);
    expect(rows.every((r) => /^el_[a-z0-9_]+$/.test(r.id))).toBe(true);
  });

  it("G-J. the chosen row resolves, validates and is clicked (pointer sequence fallback for a row without a click handler)", async () => {
    document.body.innerHTML = RESULTS;
    const extracted = await handleExtractPage("open the most recent email from John");
    if (!extracted.ok) throw new Error("extract failed");
    const rows = (JSON.parse(extracted.firewall.body).page.elements as Array<{ id: string; tag: string }>).filter((e) => e.tag === "tr");
    const row = document.querySelector("tr") as HTMLElement;
    const opened = vi.fn();
    row.addEventListener("mousedown", opened);
    const result = await handleExecuteAction({ action: "click", target: rows[0].id, confidence: 1, reason: "most recent from John" });
    expect(result.ok).toBe(true);
    expect(result.trace).toMatchObject({ action: "click", resolution: "ps-id", validation: "PASS", execution: "PASS" });
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
