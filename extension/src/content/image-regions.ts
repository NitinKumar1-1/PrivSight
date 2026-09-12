/**
 * Visible picture regions on the page (Phase 7).
 *
 * Pictures never leave the browser: the cloud receives text only. The popup's
 * local preview, however, is rendered from the raw capture, so photos on the
 * page (a profile picture, a product image, an uploaded document) would be
 * visible in it. This module lists the viewport rectangles of visible images
 * and videos so the preview renderer can cover them, making "no image leaves
 * this device" visible as well as true. Coordinates are CSS pixels relative
 * to the viewport; the controller scales them to capture pixels.
 */

import type { BBox } from "../vision/types";

const IMAGE_SELECTOR = "img, video, picture, object[type^='image'], embed[type^='image']";
/** Smaller pictures are icons and decorations, not user content. */
const MIN_SIZE_PX = 32;
const MAX_REGIONS = 200;

export function visibleImageRegions(root: Document = document): BBox[] {
  const view = root.defaultView;
  const width = view?.innerWidth ?? root.documentElement.clientWidth;
  const height = view?.innerHeight ?? root.documentElement.clientHeight;
  const regions: BBox[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(IMAGE_SELECTOR)) {
    if (regions.length >= MAX_REGIONS) break;
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(width, rect.right);
    const bottom = Math.min(height, rect.bottom);
    if (right - x < MIN_SIZE_PX || bottom - y < MIN_SIZE_PX) continue;
    if (!isRendered(element, view)) continue;
    regions.push({ x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) });
  }
  return regions;
}

function isRendered(element: HTMLElement, view: Window | null): boolean {
  if (element.hidden) return false;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/** Scales viewport CSS-pixel boxes to capture pixels. */
export function scaleRegions(regions: BBox[], devicePixelRatio: number): BBox[] {
  const f = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return regions.map((r) => ({ x: Math.round(r.x * f), y: Math.round(r.y * f), width: Math.round(r.width * f), height: Math.round(r.height * f) }));
}
