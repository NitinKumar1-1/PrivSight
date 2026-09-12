/**
 * Phase 7: pictures are covered in the local preview. They never leave the
 * browser; this makes it visible.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { runAgent, type AgentEvent, type AgentPorts } from "../../src/agent/controller";
import { scaleRegions, visibleImageRegions } from "../../src/content/image-regions";
import type { ApprovedPayload, FirewallVerdict } from "../../src/privacy/types";
import type { ExtractPageResult } from "../../src/shared/messages";

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const [left, top, w, h] = (el.dataset.rect ?? "0,0,0,0").split(",").map(Number);
    return { left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) };
  };
});

describe("visibleImageRegions", () => {
  it("lists visible images and videos, clipped to the viewport, and skips icons, hidden and off-screen pictures", () => {
    document.body.innerHTML = `
      <img data-rect="10,20,200,150" alt="profile photo">
      <img data-rect="900,700,300,300" alt="partly off-screen">
      <img data-rect="0,0,16,16" alt="icon">
      <img data-rect="50,50,100,100" hidden alt="hidden">
      <img data-rect="50,50,100,100" style="display:none" alt="display none">
      <video data-rect="300,300,320,180"></video>
      <img data-rect="0,2000,200,200" alt="below the fold">
    `;
    expect(visibleImageRegions()).toEqual([
      { x: 10, y: 20, width: 200, height: 150 },
      { x: 900, y: 700, width: 100, height: 100 },
      { x: 300, y: 300, width: 320, height: 180 },
    ]);
  });

  it("scales CSS pixels to capture pixels", () => {
    expect(scaleRegions([{ x: 10, y: 20, width: 30, height: 40 }], 2)).toEqual([{ x: 20, y: 40, width: 60, height: 80 }]);
    expect(scaleRegions([{ x: 10, y: 20, width: 30, height: 40 }], 0)).toEqual([{ x: 10, y: 20, width: 30, height: 40 }]);
  });
});

describe("controller covers pictures in the preview", () => {
  function ports(withVisual: boolean, events: AgentEvent[], calls: Array<{ regions: number; images: number }>): AgentPorts {
    const firewall: FirewallVerdict = { verdict: "allowed", body: JSON.stringify({ task: "t", page: { url: "u", title: "t", elements: [], text: "" }, placeholders: [] }) as ApprovedPayload, checks: [] };
    const extracted: ExtractPageResult = {
      ok: true,
      summary: { placeholders: [], types: {}, detections: [] },
      firewall,
      visualPrivacy: withVisual ? { ocrLines: 1, observationsSent: 0, redactedObservations: 0, maskRegions: [{ type: "EMAIL", bbox: { x: 1, y: 1, width: 2, height: 2 } }], conflicts: [], fusion: { duplicatesDropped: 0, visualOnly: 0, buttonsMapped: 0, conflictsDropped: 0 } } : null,
      imageRegions: [{ x: 10, y: 10, width: 100, height: 50 }],
    };
    let clock = 0;
    return {
      ensureContentScript: async () => undefined,
      capture: async () => ({ dataUrl: "data:image/png;base64,AAAA", devicePixelRatio: 2 }),
      perceive: async () => null,
      visionInfo: async () => null,
      extract: async () => extracted,
      reason: async () => ({ action: "done", confidence: 1, reason: "" }),
      execute: async () => ({ ok: true, message: "done", validation: "pass" }),
      renderMask: async (_c, regions, images) => {
        calls.push({ regions: regions.length, images: images?.length ?? 0 });
        return "data:image/png;base64,MASK";
      },
      report: (e) => void events.push(e),
      now: () => (clock += 1),
    };
  }

  it("with OCR regions: pictures are passed alongside, scaled by the device pixel ratio", async () => {
    const events: AgentEvent[] = [];
    const calls: Array<{ regions: number; images: number }> = [];
    await runAgent("t", ports(true, events, calls));
    expect(calls).toEqual([{ regions: 1, images: 1 }]);
    const preview = events.find((e) => e.kind === "preview");
    expect(preview).toMatchObject({ kind: "preview", maskCount: 1, imageCount: 1, maskedDataUrl: "data:image/png;base64,MASK" });
  });

  it("without OCR this round: the preview is still rendered with the pictures covered", async () => {
    const events: AgentEvent[] = [];
    const calls: Array<{ regions: number; images: number }> = [];
    await runAgent("t", ports(false, events, calls));
    expect(calls).toEqual([{ regions: 0, images: 1 }]);
    expect(events.find((e) => e.kind === "preview")).toMatchObject({ maskCount: 0, imageCount: 1 });
  });
});
