/**
 * Task-authorised navigation (Phase 7).
 *
 * The reasoner may propose `navigate`, but the agent only opens a website the
 * user's task names ("on amazon, add PS-5 to cart" names amazon) or the site
 * that is already open (a search URL on the same site). Anything else is
 * blocked locally. Deterministic; the model cannot widen it because the task
 * text comes from the popup.
 */

const PUBLIC_SUFFIX_SECOND_LABELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go"]);

/** The name a person would use for a host: "www.amazon.co.uk" -> "amazon", "en.wikipedia.org" -> "wikipedia", "localhost" -> "localhost". */
export function siteLabel(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(":")[0].split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? "";
  let end = labels.length - 1; // drop the top-level label
  if (end >= 2 && PUBLIC_SUFFIX_SECOND_LABELS.has(labels[end - 1]) && labels[end].length <= 3) end -= 1; // "co.uk", "com.au"
  return labels[end - 1] ?? labels[0];
}

/** Reason to block navigation to `url` under `task` from `currentUrl`, or null to allow. */
export function navigationBlockReason(url: string, task: string, currentUrl: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return "Navigation blocked: the URL is not valid";
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return "Navigation blocked: only http and https URLs are allowed";
  const label = siteLabel(target.host);
  if (!label) return "Navigation blocked: the URL has no host";
  const named = new RegExp(`(^|[^a-z0-9])${escape(label)}([^a-z0-9]|$)`, "i").test(task);
  if (named) return null;
  try {
    if (siteLabel(new URL(currentUrl).host) === label) return null; // staying on the site that is already open
  } catch {
    // no current page: only a named site is allowed
  }
  return `Navigation to ${target.host} blocked: the task does not name this website`;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
